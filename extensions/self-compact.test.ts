import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth, type Component } from "@earendil-works/pi-tui";
import {
  fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore,
  type AssistantMessage, type FauxResponseStep, type SimpleStreamOptions, type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  createAgentSession, DefaultResourceLoader, initTheme, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession, type ExtensionFactory, type SessionEntry, type Theme,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import selfCompact, { SELF_COMPACT_MESSAGE, SELF_COMPACT_TOOL } from "./self-compact.ts";
import { SELF_COMPACT_HANDOFF_EVENT, type SelfCompactHandoff } from "../orchestration/self-compact-handoff.ts";
import workerFrame, { createWorkerArtifacts, parseWorkerResult, readWorkerStatus, writeWorkerRequest } from "../orchestration/worker-frame.ts";

initTheme("dark");
const PAD = "x".repeat(2_000);
type Step = AssistantMessage | ((signal: AbortSignal | undefined) => Promise<AssistantMessage>);

const compactCall = (note: string, id = "compact-1") =>
  fauxAssistantMessage(fauxToolCall(SELF_COMPACT_TOOL, { note }, { id }), { stopReason: "toolUse" });

function text(context: TranscriptContext): string {
  return JSON.stringify(context.messages);
}

/** Native compaction (history and split-turn prefix) summarizes without tools; working requests always declare some. */
function isSummaryRequest(context: TranscriptContext): boolean {
  return !context.messages.some((message) => message.role === "system" && (message.toolsAdded?.length ?? 0) > 0);
}

/** Real Pi SDK session with a registry-registered faux provider; summary and working requests are recorded separately. */
async function fixture(t: TestContext, keepRecentTokens = 300, before: ExtensionFactory[] = [], after: ExtensionFactory[] = []) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-self-compact-"));
  const agentDir = path.join(directory, "agent");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const provider = fauxProvider({ provider: "self-compact-test", tokensPerSecond: 1_000_000 });
  const work: Step[] = [];
  const workRequests: TranscriptContext[] = [];
  const summaryRequests: TranscriptContext[] = [];
  let summary: (signal: AbortSignal | undefined) => Promise<string> = async () => `SUMMARY-${summaryRequests.length}`;
  const dispatch: FauxResponseStep = async (context: TranscriptContext, options: SimpleStreamOptions | undefined) => {
    if (isSummaryRequest(context)) {
      summaryRequests.push(context);
      return fauxAssistantMessage(await summary(options?.signal));
    }
    workRequests.push(context);
    const step = work.shift();
    assert.ok(step, "unexpected working request");
    return typeof step === "function" ? await step(options?.signal) : step;
  };
  provider.setResponses(Array.from({ length: 50 }, () => dispatch));
  const noopCalls: string[] = [];
  const handoffs: SelfCompactHandoff[] = [];
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsPath: null,
    modelsStorePath: path.join(agentDir, "models-store.json"), allowModelNetwork: false,
  });
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false, keepRecentTokens, reserveTokens: 2_000 }, retry: { enabled: false },
  });
  const loader = new DefaultResourceLoader({
    cwd: directory, agentDir, settingsManager, noExtensions: true, noSkills: true,
    noContextFiles: true, noPromptTemplates: true, noThemes: true,
    extensionFactories: [(pi) => {
      pi.registerProvider(provider.provider);
      pi.registerTool({
        name: "noop", label: "noop", description: "Test sibling tool.", parameters: Type.Object({}),
        async execute(toolCallId) {
          noopCalls.push(toolCallId);
          return { content: [{ type: "text", text: "noop done" }], details: {} };
        },
      });
      pi.events.on(SELF_COMPACT_HANDOFF_EVENT, (event) => handoffs.push(event as SelfCompactHandoff));
    }, ...before, selfCompact, ...after],
  });
  await loader.reload();
  const created = await createAgentSession({
    cwd: directory, agentDir, modelRuntime, settingsManager, resourceLoader: loader,
    model: provider.getModel(), thinkingLevel: "off", tools: ["noop", SELF_COMPACT_TOOL],
    sessionManager: SessionManager.create(directory, path.join(directory, "sessions")),
  });
  const session: AgentSession = created.session;
  t.after(() => session.dispose());
  assert.deepEqual(created.extensionsResult.errors, []);
  const errors: string[] = [];
  await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error.error) });
  await modelRuntime.setRuntimeApiKey(provider.provider.id, "fixture-key");
  await modelRuntime.getAvailable();
  t.after(() => assert.deepEqual(errors, []));

  /** Wait until every scripted working response is used and the session has settled with no compaction running. */
  async function settle() {
    for (let attempt = 0; attempt < 400; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (work.length === 0 && session.isIdle) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        if (work.length === 0 && session.isIdle) return;
      }
    }
    assert.fail("session did not settle");
  }
  async function run(prompt: string, steps: Step[]) {
    work.push(...steps);
    await session.prompt(prompt);
    await settle();
  }
  const branch = (): SessionEntry[] => session.sessionManager.getBranch();
  const reports = () => branch().flatMap((entry) =>
    entry.type === "custom_message" && entry.customType === SELF_COMPACT_MESSAGE ? [String(entry.content)] : []);
  const compactions = () => branch().filter((entry) => entry.type === "compaction");
  return {
    session, loader, run, settle, work, workRequests, summaryRequests, noopCalls, reports, compactions, handoffs,
    setSummary: (fn: typeof summary) => { summary = fn; },
  };
}

test("the default tool display shows the full handoff note during streaming and after execution", async (t) => {
  let theme: Theme | undefined;
  const f = await fixture(t, 300, [(pi) => {
    pi.on("session_start", (_event, ctx) => { theme = ctx.ui.theme; });
  }]);
  assert.ok(theme);
  const tool = f.loader.getExtensions().extensions
    .flatMap((extension) => [...extension.tools.values()])
    .find(({ definition }) => definition.name === SELF_COMPACT_TOOL)?.definition;
  assert.ok(tool?.renderCall);
  const context: Parameters<typeof tool.renderCall>[2] & { args: { note?: string } } = {
    args: {}, toolCallId: "display-test", invalidate() {}, lastComponent: undefined, state: {},
    cwd: process.cwd(), executionStarted: false, argsComplete: false, isPartial: true,
    expanded: false, showImages: false, isError: false,
  };
  const note = 'Goal: keep "quotes" and literal \\n.\n\n  Preserve indentation.\n' +
    Array.from({ length: 25 }, (_, i) => `Completed step ${i}.`).join("\n") +
    "\nNext action: continue with 界面 tests.";
  for (const args of [{}, { note: "Goal: keep" }, { note }]) {
    context.args = Object.freeze(args);
    const component: Component = tool.renderCall(context.args, theme, context);
    const lines = component.render(100).map((line) => stripVTControlCharacters(line).trimEnd());
    assert.deepEqual(lines, ["self_compact", "Handoff note:", ...(args.note ?? "").split("\n")]);
    if (context.lastComponent) assert.equal(component, context.lastComponent);
    context.lastComponent = component;
  }
  context.executionStarted = true;
  context.argsComplete = true;
  context.isPartial = false;
  for (const expanded of [false, true]) {
    context.expanded = expanded;
    const component = tool.renderCall(context.args, theme, context);
    for (const width of [20, 80]) {
      const lines = component.render(width);
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
      assert.match(stripVTControlCharacters(lines.join("\n")), /Completed step 24\./);
    }
    component.invalidate();
    assert.ok(component.render(100).map(stripVTControlCharacters).join("\n").includes("Next action: continue with 界面 tests."));
  }
  assert.equal(context.args.note, note, "display leaves the actual handoff unchanged");
});

test("self_compact runs native compaction, keeps recent messages, delivers the note verbatim, and continues once", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  await f.run(`OLD-TASK ${PAD}`, [fauxAssistantMessage("old done")]);
  const note = "  Goal: finish.\nNext action: write result.txt  ";
  await f.run(`RECENT-TASK ${PAD}`, [compactCall(note), fauxAssistantMessage("continued")]);

  assert.equal(f.summaryRequests.length, 1);
  assert.match(text(f.summaryRequests[0]!), /OLD-TASK/);
  assert.doesNotMatch(text(f.summaryRequests[0]!), /RECENT-TASK/);
  assert.equal(f.compactions().length, 1);
  assert.deepEqual(f.reports(), [note]);

  assert.equal(f.workRequests.length, 3, "exactly one continuation request");
  const continuation = f.workRequests[2]!;
  const serialized = text(continuation);
  assert.match(serialized, /SUMMARY-1/);
  assert.match(serialized, /RECENT-TASK/, "recent turn retained");
  assert.doesNotMatch(serialized, /OLD-TASK/);
  const last = continuation.messages.at(-1)!;
  assert.equal(last.role, "user");
  assert.equal(JSON.stringify(last.content).includes(JSON.stringify(note).slice(1, -1)), true, "note delivered verbatim last");
  const leaf = f.session.sessionManager.getLeafEntry();
  assert.ok(leaf?.type === "message" && leaf.message.role === "assistant");
});

test("repeated cycles chain the previous summary", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  await f.run(`TURN-1 ${PAD}`, [fauxAssistantMessage("one")]);
  await f.run(`TURN-2 ${PAD}`, [compactCall("note one", "c1"), fauxAssistantMessage("after one")]);
  await f.run(`TURN-3 ${PAD}`, [compactCall("note two", "c2"), fauxAssistantMessage("after two")]);
  assert.equal(f.summaryRequests.length, 2);
  assert.match(text(f.summaryRequests[1]!), /previous-summary[\s\S]*SUMMARY-1/);
  assert.equal(f.compactions().length, 2);
  assert.deepEqual(f.reports(), ["note one", "note two"]);
  assert.match(text(f.workRequests.at(-1)!), /SUMMARY-2/);
});

test("mixed batches are rejected without affecting siblings or compacting", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  await f.run(`OLD ${PAD}`, [fauxAssistantMessage("old done")]);
  await f.run(`NEW ${PAD}`, [
    fauxAssistantMessage([fauxToolCall(SELF_COMPACT_TOOL, { note: "n" }, { id: "c" }), fauxToolCall("noop", {}, { id: "n" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("carried on"),
  ]);
  assert.deepEqual(f.noopCalls, ["n"]);
  assert.match(text(f.workRequests.at(-1)!), /must be the only tool call/);
  assert.equal(f.summaryRequests.length, 0);
  assert.equal(f.compactions().length, 0);
  assert.deepEqual(f.reports(), []);
});

test("a blank note is rejected and nothing is compacted", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  await f.run(`OLD ${PAD}`, [fauxAssistantMessage("old done")]);
  await f.run(`NEW ${PAD}`, [compactCall("  \n"), fauxAssistantMessage("carried on")]);
  assert.match(text(f.workRequests.at(-1)!), /must not be blank/);
  assert.equal(f.summaryRequests.length, 0);
  assert.equal(f.compactions().length, 0);
});

test("nothing to compact is reported without continuing", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t, 1_000_000);
  await f.run("small", [compactCall("note")]);
  assert.equal(f.workRequests.length, 1);
  assert.equal(f.compactions().length, 0);
  const reports = f.reports();
  assert.equal(reports.length, 1);
  assert.match(reports[0]!, /Self-compaction failed: Nothing to compact/);
});

test("cancelling compaction commits nothing, reports it, and does not continue", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  await f.run(`OLD ${PAD}`, [fauxAssistantMessage("old done")]);
  f.setSummary(async (signal) => {
    assert.ok(signal);
    await new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
      setImmediate(() => f.session.abortCompaction());
    });
    return "LATE SUMMARY";
  });
  await f.run(`NEW ${PAD}`, [compactCall("note")]);
  assert.equal(f.summaryRequests.length, 1);
  assert.equal(f.workRequests.length, 2);
  assert.equal(f.compactions().length, 0);
  const reports = f.reports();
  assert.equal(reports.length, 1);
  assert.match(reports[0]!, /^Self-compaction failed: /);
});

test("the reminder appears only at or above the threshold and only for the working request", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  let percent: number | null = null;
  t.mock.method(f.session, "getContextUsage", () => ({ tokens: percent === null ? null : percent * 1_000, contextWindow: 100_000, percent }));
  await f.run("a", [fauxAssistantMessage("ok")]);
  for (const usage of [60, 68.9, 69, 75]) {
    percent = usage;
    await f.run(`usage ${usage}`, [fauxAssistantMessage("ok")]);
  }
  f.session.setActiveToolsByName(["noop"]);
  await f.run("disabled", [fauxAssistantMessage("ok")]);
  const reminder = "Context usage has grown significantly. If the original user request is nearly complete, finish it without using self_compact. If your work requires everything in current context continue the work. If the context contains a lot of irrelevant information, call self_compact alone with your handoff note on how to continue.";
  const reminded = f.workRequests.map((context) => text(context).includes(reminder));
  assert.deepEqual(reminded, [false, false, false, true, true, false]);
  const completionGuidance = /If the original user request is nearly complete, finish it without self_compact\./;
  assert.match(text(f.workRequests[0]!), completionGuidance, "tool guidance applies before the reminder threshold");
  for (const context of f.workRequests.slice(3, 5)) {
    assert.ok(JSON.stringify(context.messages.at(-1)).includes(reminder), "reminder uses the exact generic wording");
    assert.doesNotMatch(JSON.stringify(context.messages.at(-1)), /\d+%|\d+ tokens/, "reminder omits usage numbers");
  }
  assert.doesNotMatch(JSON.stringify(f.session.sessionManager.getBranch()), /Context usage has grown significantly/, "reminder is not persisted");
});

async function runWorker(t: TestContext, f: Awaited<ReturnType<typeof fixture>>, steps: Step[]) {
  const paths = createWorkerArtifacts();
  t.after(() => fs.rmSync(paths.artifactDir, { recursive: true, force: true }));
  const model = f.session.model!;
  writeWorkerRequest(paths, {
    id: "compacting-worker", task: `Finish the original request. ${PAD}`,
    tools: ["noop", SELF_COMPACT_TOOL], model: { provider: model.provider, id: model.id },
    thinkingLevel: "off", resultPath: paths.resultPath, statusPath: paths.statusPath,
  });
  f.work.push(...steps);
  await f.session.prompt(`/worker-run ${paths.requestPath}`);
  if (fs.existsSync(paths.resultPath)) {
    const result = parseWorkerResult(fs.readFileSync(paths.resultPath, "utf8"), paths.resultPath, "compacting-worker");
    assert.equal(result.isError, false, result.result);
  }
  await f.settle();
  return paths;
}

for (const order of ["worker-first", "compactor-first"] as const) {
  test(`worker automatically publishes after repeated compaction (${order})`, { timeout: 20_000 }, async (t) => {
    const f = await fixture(t, 300, order === "worker-first" ? [workerFrame] : [], order === "compactor-first" ? [workerFrame] : []);
    await f.run(`Inherited history ${PAD}`, [fauxAssistantMessage("Earlier work")]);
    const paths = await runWorker(t, f, [
      compactCall(`First handoff ${PAD}`, "first"),
      compactCall(`Second handoff ${PAD}`, "second"),
      fauxAssistantMessage("Final parent result"), fauxAssistantMessage("everything was ok"),
    ]);
    const result = parseWorkerResult(fs.readFileSync(paths.resultPath, "utf8"), paths.resultPath, "compacting-worker");
    assert.equal(result.result, "Final parent result");
    assert.equal(result.retrospective, "everything was ok");
    assert.equal(result.isError, false);
    assert.equal(readWorkerStatus(paths.statusPath)?.state, "closed");
    assert.equal(f.compactions().length, 2);
    assert.ok(f.summaryRequests.length >= 2, "native compaction can separately summarize a split turn");
    assert.deepEqual(f.handoffs, [
      { state: "pending", toolCallId: "first" }, { state: "resumed", toolCallId: "first" },
      { state: "pending", toolCallId: "second" }, { state: "resumed", toolCallId: "second" },
    ]);
    for (const request of f.workRequests) assert.doesNotMatch(text(request), /A human is supervising/);
  });
}

for (const failure of ["empty", "error", "cancelled", "cancel-before", "moved-before", "moved-after"] as const) {
  test(`worker reports ${failure} compaction without silently waiting or publishing`, { timeout: 20_000 }, async (t) => {
    const interrupt: ExtensionFactory = (pi) => {
      if (failure === "cancel-before") pi.on("tool_result", (event, ctx) => {
        if (event.toolName === SELF_COMPACT_TOOL) ctx.abort();
      });
      if (failure === "moved-before") pi.on("agent_settled", (_event, ctx) => {
        const leaf = ctx.sessionManager.getLeafEntry();
        if (leaf?.type === "message" && leaf.message.role === "toolResult") pi.appendEntry("moved", {});
      });
      if (failure === "moved-after") pi.on("session_compact", () => { pi.appendEntry("moved", {}); });
    };
    const f = await fixture(t, failure === "empty" ? 1_000_000 : 300, [workerFrame, interrupt]);
    await f.run(`Inherited history ${PAD}`, [fauxAssistantMessage("Earlier work")]);
    if (failure === "error") f.setSummary(async () => { throw new Error("Summary provider unavailable"); });
    if (failure === "cancelled") f.setSummary(async (signal) => {
      assert.ok(signal);
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
        setImmediate(() => f.session.abortCompaction());
      });
      return "Cancelled summary";
    });
    const paths = await runWorker(t, f, [compactCall("Do the remaining work")]);
    assert.equal(fs.existsSync(paths.resultPath), false);
    const status = readWorkerStatus(paths.statusPath);
    assert.equal(status?.state, "supervised");
    assert.match(status?.supervisionReason ?? "", /Self-compaction/);
    assert.equal(f.handoffs.length, 2);
    assert.equal(f.handoffs[0]?.state, "pending");
    assert.equal(f.handoffs[1]?.state, "failed");
    assert.equal(f.reports().length, 1);
    assert.match(f.reports()[0]!, failure.startsWith("moved") ? /skipped/ : /failed|cancelled/);
    assert.equal(f.workRequests.length, 2, "no unsolicited continuation");
    assert.equal(f.compactions().length, failure === "moved-after" ? 1 : 0);

    // Explicit human recovery still uses the normal automatic completion path.
    f.work.push(fauxAssistantMessage("Recovered result"), fauxAssistantMessage("everything was ok"));
    await f.session.prompt("/worker-continue Finish without compacting");
    await f.settle();
    const result = parseWorkerResult(fs.readFileSync(paths.resultPath, "utf8"), paths.resultPath, "compacting-worker");
    assert.equal(result.result, "Recovered result");
  });
}

test("reload retires a pending handoff and ignores its late compaction callback", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  await f.run(`Inherited history ${PAD}`, [fauxAssistantMessage("Earlier work")]);
  f.setSummary(async () => {
    await f.session.reload();
    return "Summary completed after reload";
  });
  await f.run(`Remaining task ${PAD}`, [compactCall("Do not deliver after reload")]);
  assert.equal(f.workRequests.length, 2);
  assert.deepEqual(f.reports(), []);
  assert.deepEqual(f.handoffs, [
    { state: "pending", toolCallId: "compact-1" },
    { state: "failed", toolCallId: "compact-1", reason: "Self-compaction cancelled: session shut down before the handoff." },
  ]);
  // The replacement instance still supports normal compaction.
  f.setSummary(async () => "New summary");
  await f.run(`New task ${PAD}`, [compactCall("New note", "new"), fauxAssistantMessage("continued")]);
  assert.deepEqual(f.reports(), ["New note"]);
  assert.equal(f.handoffs.at(-1)?.state, "resumed");
});

test("failed compaction during retrospective preserves the main result", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t, 1_000_000, [workerFrame]);
  const paths = await runWorker(t, f, [fauxAssistantMessage("Saved main result"), compactCall("Unnecessary retrospective compaction")]);
  const result = parseWorkerResult(fs.readFileSync(paths.resultPath, "utf8"), paths.resultPath, "compacting-worker");
  assert.equal(result.result, "Saved main result");
  assert.equal(result.isError, false);
  assert.match(result.retrospective ?? "", /retrospective unavailable.*Self-compaction failed/s);
  assert.equal(readWorkerStatus(paths.statusPath)?.state, "closed");
});

test("human supervision survives a successful compaction handoff", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t, 300, [workerFrame]);
  await f.run(`Inherited history ${PAD}`, [fauxAssistantMessage("Earlier work")]);
  const paths = await runWorker(t, f, [
    async () => {
      await f.session.prompt("Discuss this with me before submitting.", { streamingBehavior: "followUp" });
      return fauxAssistantMessage("Considering the human guidance");
    },
    compactCall("Continue the unfinished work"),
    fauxAssistantMessage("Discussion reply"),
  ]);
  assert.equal(readWorkerStatus(paths.statusPath)?.state, "supervised");
  assert.equal(fs.existsSync(paths.resultPath), false);
  assert.equal(f.handoffs.at(-1)?.state, "resumed");
  assert.equal(f.compactions().length, 1);
  f.work.push(fauxAssistantMessage("everything was ok"));
  await f.session.prompt("/worker-submit");
  await f.settle();
  const result = parseWorkerResult(fs.readFileSync(paths.resultPath, "utf8"), paths.resultPath, "compacting-worker");
  assert.equal(result.result, "Discussion reply");
});
