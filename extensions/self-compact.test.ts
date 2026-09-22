import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import {
  fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore,
  type AssistantMessage, type FauxResponseStep, type SimpleStreamOptions, type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession, type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import selfCompact, { SELF_COMPACT_MESSAGE, SELF_COMPACT_TOOL } from "./self-compact.ts";

const PAD = "x".repeat(2_000);
type Step = AssistantMessage | ((signal: AbortSignal | undefined) => Promise<AssistantMessage>);

const compactCall = (note: string, id = "compact-1") =>
  fauxAssistantMessage(fauxToolCall(SELF_COMPACT_TOOL, { note }, { id }), { stopReason: "toolUse" });

function text(context: TranscriptContext): string {
  return JSON.stringify(context.messages);
}

/** Real Pi SDK session with a registry-registered faux provider; summary and working requests are recorded separately. */
async function fixture(t: TestContext, keepRecentTokens = 300) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-self-compact-"));
  const agentDir = path.join(directory, "agent");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const provider = fauxProvider({ provider: "self-compact-test", tokensPerSecond: 1_000_000 });
  const work: Step[] = [];
  const workRequests: TranscriptContext[] = [];
  const summaryRequests: TranscriptContext[] = [];
  let summary: (signal: AbortSignal | undefined) => Promise<string> = async () => `SUMMARY-${summaryRequests.length}`;
  const dispatch: FauxResponseStep = async (context: TranscriptContext, options: SimpleStreamOptions | undefined) => {
    if (text(context).includes("<conversation>")) {
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
      selfCompact(pi);
    }],
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
    session, run, settle, work, workRequests, summaryRequests, noopCalls, reports, compactions,
    setSummary: (fn: typeof summary) => { summary = fn; },
  };
}

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
  percent = 49;
  await f.run("b", [fauxAssistantMessage("ok")]);
  percent = 50;
  await f.run("c", [fauxAssistantMessage("ok")]);
  const reminded = f.workRequests.map((context) => /Context usage is \d+%.*call self_compact alone/.test(text(context)));
  assert.deepEqual(reminded, [false, false, true]);
  assert.doesNotMatch(JSON.stringify(f.session.sessionManager.getBranch()), /Context usage is/, "reminder is not persisted");
});
