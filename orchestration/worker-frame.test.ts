import assert from "node:assert/strict";
import * as fs from "node:fs";
import test, { type TestContext } from "node:test";
import { createEventBus, type EventBus } from "@earendil-works/pi-coding-agent";
import { SELF_COMPACT_HANDOFF_EVENT, type SelfCompactHandoff } from "./self-compact-handoff.ts";
import workerFrameExtension, {
  createWorkerArtifacts,
  formatWorkerResult,
  formatWorkerRetryTime,
  parseWorkerResult,
  readWorkerStatus,
  writeWorkerRequest,
  type WorkerArtifactPaths,
} from "./worker-frame.ts";

type WorkerFramePi = Parameters<typeof workerFrameExtension>[0];
type EventHandler = (event: unknown, ctx: unknown) => unknown;
type CommandHandler = (args: string, ctx: unknown) => unknown;

interface WorkerFrameHarness {
  activeTools: string[];
  events: EventBus;
  selectedModel?: unknown;
  modelFailure?: Error;
  modelReady?: Promise<void>;
  thinkingLevel?: string;
  commands: Map<string, CommandHandler>;
  context: { isIdle(): boolean; abort(): void | Promise<void> };
  handlers: Map<string, EventHandler[]>;
  notifications: string[];
  recoveryPolicies: boolean[];
  sentRecoveryPolicies: Array<boolean | undefined>;
  sentDeliveryModes: Array<"steer" | "followUp" | undefined>;
  sentMessages: string[];
  shutdowns: number;
  statuses: Map<string, string | undefined>;
  waitForIdle: () => Promise<void>;
  widgets: Map<string, string[] | undefined>;
}

function createHarness(): WorkerFrameHarness {
  const commands = new Map<string, CommandHandler>();
  const handlers = new Map<string, EventHandler[]>();
  const notifications: string[] = [];
  const sentMessages: string[] = [];
  const statuses = new Map<string, string | undefined>();
  const widgets = new Map<string, string[] | undefined>();

  const harness: WorkerFrameHarness = {
    activeTools: ["read", "bash"],
    events: createEventBus(),
    commands,
    context: { isIdle: () => true, abort: () => undefined },
    handlers,
    notifications,
    recoveryPolicies: [],
    sentRecoveryPolicies: [],
    sentDeliveryModes: [],
    sentMessages,
    shutdowns: 0,
    statuses,
    waitForIdle: async () => undefined,
    widgets,
  };

  harness.events.on("pi-claude-agent:recovery-policy", (data) => {
    harness.recoveryPolicies.push((data as { allowed: boolean }).allowed);
  });

  const pi = {
    events: harness.events,
    getActiveTools: () => [...harness.activeTools],
    getAllTools: () => ["read", "bash", "do", "delegate", "fresh_look"].map((name) => ({ name })),
    on: (name: string, handler: EventHandler) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerCommand: (name: string, command: { handler: CommandHandler }) => {
      commands.set(name, command.handler);
    },
    sendUserMessage: (message: string, options?: { deliverAs?: "steer" | "followUp" }) => {
      sentMessages.push(message);
      harness.sentRecoveryPolicies.push(harness.recoveryPolicies.at(-1));
      harness.sentDeliveryModes.push(options?.deliverAs);
    },
    setModel: async (model: unknown) => {
      await harness.modelReady;
      if (harness.modelFailure) throw harness.modelFailure;
      harness.selectedModel = model;
      return true;
    },
    setThinkingLevel: (level: string) => { harness.thinkingLevel = level; },
    setActiveTools: (tools: string[]) => {
      harness.activeTools = [...tools];
    },
  } as unknown as WorkerFramePi;

  Object.assign(harness.context, {
    modelRegistry: { find: (provider: string, id: string) => ({ provider, id }) },
    getContextUsage: () => ({ percent: 12.5 }),
    sessionManager: {
      getBranch: () => [],
      getSessionFile: () => "/tmp/worker-frame-test-session.jsonl",
      getSessionId: () => "worker-frame-test",
    },
    shutdown: () => {
      harness.shutdowns++;
    },
    ui: {
      notify: (message: string) => notifications.push(message),
      setStatus: (key: string, value: string | undefined) => statuses.set(key, value),
      setWidget: (key: string, value: string[] | undefined) => widgets.set(key, value),
      theme: {
        fg: (_color: string, text: string) => text,
      },
    },
    waitForIdle: () => harness.waitForIdle(),
  });

  workerFrameExtension(pi);
  return harness;
}

async function emit(harness: WorkerFrameHarness, name: string, event: unknown): Promise<void> {
  const registered = harness.handlers.get(name) ?? [];
  assert.ok(registered.length > 0, `No handler registered for ${name}`);
  for (const handler of registered) {
    await handler(event, harness.context);
  }
}

async function runCommand(harness: WorkerFrameHarness, name: string, args = ""): Promise<void> {
  const handler = harness.commands.get(name);
  if (!handler) throw new Error(`No command registered for ${name}`);
  await handler(args, harness.context);
}

function assistantMessage(text: string): unknown {
  return { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" };
}

function assistantEvent(text: string): unknown {
  return { messages: [assistantMessage(text)] };
}

function assistantErrorEvent(errorMessage: string, partialText = ""): unknown {
  return {
    messages: [{
      role: "assistant",
      content: partialText ? [{ type: "text", text: partialText }] : [],
      stopReason: "error",
      errorMessage,
    }],
  };
}

function assistantAbortEvent(): unknown {
  return { messages: [{ role: "assistant", content: [], stopReason: "aborted", errorMessage: "Operation aborted by user" }] };
}

/** Writes a request for one test; its artifacts go when the test ends. */
function request(t: TestContext, id: string, tools = ["read", "bash"]): WorkerArtifactPaths {
  const paths = createWorkerArtifacts();
  t.after(() => fs.rmSync(paths.artifactDir, { recursive: true, force: true }));
  writeWorkerRequest(paths, {
    id, task: `Task of ${id}`, tools, model: { provider: "fake", id: "fake" }, thinkingLevel: "high",
    resultPath: paths.resultPath, statusPath: paths.statusPath,
  });
  return paths;
}

async function started(t: TestContext, id: string): Promise<{ harness: WorkerFrameHarness; paths: WorkerArtifactPaths }> {
  const harness = createHarness();
  const paths = request(t, id);
  await runCommand(harness, "worker-run", paths.requestPath);
  return { harness, paths };
}

async function failSettled(harness: WorkerFrameHarness, event: unknown = assistantAbortEvent()): Promise<void> {
  await emit(harness, "agent_end", event);
  await emit(harness, "agent_settled", {});
}

const state = (paths: WorkerArtifactPaths) => readWorkerStatus(paths.statusPath)?.state;
const reason = (paths: WorkerArtifactPaths) => readWorkerStatus(paths.statusPath)?.waitingReason;
const finalResult = (paths: WorkerArtifactPaths, id: string) => parseWorkerResult(fs.readFileSync(paths.resultPath, "utf8"), paths.resultPath, id);

for (const toolName of ["do", "delegate", "fresh_look"]) {
  test(`${toolName}: worker tools follow the request and only the first immediate subworker call is warned`, async (t) => {
    const harness = createHarness();
    const paths = request(t, "nested-worker", ["read", toolName, "unavailable-tool"]);
    await runCommand(harness, "worker-run", paths.requestPath);
    assert.deepEqual(harness.activeTools, ["read", toolName]);
    assert.deepEqual(harness.selectedModel, { provider: "fake", id: "fake" });
    assert.equal(harness.thinkingLevel, "high");

    const toolCall = harness.handlers.get("tool_call")?.[0];
    if (!toolCall) throw new Error("No tool_call handler registered");
    const warning = await toolCall({ toolName }, harness.context) as { block?: boolean; reason?: string } | undefined;
    assert.equal(warning?.block, true);
    assert.match(warning?.reason ?? "", /automated warning heuristic/);
    assert.equal(await toolCall({ toolName }, harness.context), undefined);
  });
}

test("a final reply becomes the result, then the retrospective completes and closes the worker", async (t) => {
  const { harness, paths } = await started(t, "automatic-worker");
  assert.equal(state(paths), "running");
  assert.equal(readWorkerStatus(paths.statusPath)?.pid, process.pid, "every status names the worker process");
  assert.match(harness.sentMessages[0] ?? "", /parent-facing result or blocker/);
  assert.match(harness.sentMessages[0] ?? "", /Task of automatic-worker/);

  await emit(harness, "agent_end", assistantEvent("Automatic result"));
  assert.equal(state(paths), "retrospective");
  assert.equal(fs.readFileSync(paths.resultMarkdownPath, "utf8"), "Automatic result");
  assert.deepEqual(harness.activeTools, ["read", "bash"]);
  await emit(harness, "agent_end", assistantEvent("everything was ok"));

  const result = finalResult(paths, "automatic-worker");
  assert.equal(result.result, "Automatic result");
  assert.equal(result.retrospective, "everything was ok");
  assert.equal(harness.shutdowns, 1);
  assert.equal(state(paths), "closed");
  assert.equal(readWorkerStatus(paths.statusPath)?.pid, process.pid);
  assert.deepEqual(harness.sentRecoveryPolicies, [true, false], "publish the policy before each internal prompt");
  assert.equal(harness.recoveryPolicies.at(-1), true, "completed work leaves provider recovery at its default");
});

test("human messages never change the mode, only the parent's guidance", async (t) => {
  const { harness, paths } = await started(t, "steered-worker");
  assert.equal(harness.handlers.has("context"), false);
  await emit(harness, "input", { text: "Steer", source: "rpc" });
  assert.equal(state(paths), "running");
  await emit(harness, "agent_end", assistantEvent("Reply after steering"));
  assert.equal(state(paths), "retrospective");
});

test("an interrupted worker waits until a new run, whose final reply reaches the parent", async (t) => {
  const { harness, paths } = await started(t, "interrupted-worker");
  await emit(harness, "agent_end", assistantAbortEvent());
  assert.equal(state(paths), "running", "waiting follows settlement");
  await emit(harness, "agent_settled", {});
  assert.equal(state(paths), "waiting");
  assert.match(reason(paths) ?? "", /Operation aborted by user/);
  assert.equal(harness.statuses.get("worker-frame"), "worker:waiting");
  assert.equal(harness.notifications.length, 1);
  assert.equal(fs.existsSync(paths.resultPath), false);
  assert.equal(harness.shutdowns, 0);

  // A rejected prompt starts no run, so the worker keeps waiting.
  await emit(harness, "agent_settled", {});
  assert.equal(state(paths), "waiting");
  assert.equal(harness.notifications.length, 1, "one warning per entry");

  await emit(harness, "agent_start", {});
  assert.equal(state(paths), "running");
  assert.equal(reason(paths), undefined);
  assert.equal(harness.statuses.get("worker-frame"), "worker:running");
  assert.equal(harness.widgets.get("worker-frame"), undefined);

  // A second stop waits and warns again.
  await failSettled(harness, assistantErrorEvent("Both Claude accounts exhausted: quota exceeded"));
  assert.equal(state(paths), "waiting");
  assert.match(reason(paths) ?? "", /Both Claude accounts exhausted/);
  assert.equal(harness.notifications.length, 2);

  await emit(harness, "agent_start", {});
  await emit(harness, "agent_end", assistantEvent("Recovered result"));
  await emit(harness, "agent_settled", {});
  assert.equal(state(paths), "retrospective");
  await emit(harness, "agent_end", assistantEvent("everything was ok"));
  const result = finalResult(paths, "interrupted-worker");
  assert.equal(result.result, "Recovered result");
  assert.equal(result.retrospective, "everything was ok");
  assert.equal(harness.shutdowns, 1);
});

for (const errorMessage of [
  "429 quota exceeded",
  "Claude five-hour subscription limit reached",
  "401 authentication failed",
  "Unrecognized provider failure",
]) {
  test(`unresolved assistant error waits only after settlement: ${errorMessage}`, async (t) => {
    const { harness, paths } = await started(t, "failed-inference-worker");
    await emit(harness, "agent_end", assistantErrorEvent(errorMessage, "Partial assistant prose"));
    assert.equal(state(paths), "running");
    assert.equal(harness.widgets.get("worker-frame"), undefined);
    await emit(harness, "agent_settled", {});
    await emit(harness, "agent_settled", {});

    assert.equal(state(paths), "waiting");
    assert.equal(reason(paths), `Worker run ended without a result: ${errorMessage}`);
    assert.equal(harness.statuses.get("worker-frame"), "worker:waiting");
    const widget = harness.widgets.get("worker-frame")?.join("\n") ?? "";
    assert.match(widget, /waiting for you/);
    assert.ok(widget.includes(errorMessage));
    assert.match(widget, /Type a message to continue it; its final reply goes to the parent/);
    assert.match(widget, /\/worker-return \[text\]/);
    assert.doesNotMatch(widget, /Partial assistant prose/);
    assert.match(harness.notifications.at(-1) ?? "", /waiting for you/);
    assert.equal(fs.existsSync(paths.resultPath), false);
    assert.equal(fs.existsSync(paths.resultMarkdownPath), false);
    assert.equal(harness.shutdowns, 0);
    assert.equal(harness.sentMessages.length, 1);

    await runCommand(harness, "worker-return", "Stopped by the human while the provider was unavailable");
    const result = finalResult(paths, "failed-inference-worker");
    assert.equal(result.result, "Stopped by the human while the provider was unavailable");
    assert.equal(result.retrospective, undefined);
    assert.equal(result.isError, false);
    assert.equal(harness.sentMessages.length, 1, "returning makes no further model request");
    assert.equal(harness.shutdowns, 1);
  });
}

for (const errorMessage of [
  "Connection error.",
  "429 quota exceeded",
  "500 server error: input exceeds the context window",
]) {
  test(`successful recovery before settlement completes normally: ${errorMessage}`, async (t) => {
    const { harness, paths } = await started(t, "recovered-worker");
    await emit(harness, "agent_end", assistantErrorEvent(errorMessage));
    assert.equal(state(paths), "running");
    await emit(harness, "agent_end", assistantEvent("Recovered automatically"));
    await emit(harness, "agent_settled", {});
    assert.equal(state(paths), "retrospective");
    assert.equal(reason(paths), undefined);
    assert.equal(harness.notifications.length, 0);
    await emit(harness, "agent_end", assistantEvent("everything was ok"));
    await emit(harness, "agent_settled", {});
    const result = finalResult(paths, "recovered-worker");
    assert.equal(result.result, "Recovered automatically");
    assert.equal(result.isError, false);
    assert.equal(harness.shutdowns, 1);
  });
}

for (const errorMessage of ["Connection error.", "429 quota exceeded"]) {
  test(`retrospective failure preserves the main result after settlement: ${errorMessage}`, async (t) => {
    const { harness, paths } = await started(t, "retrospective-retry-worker");
    await emit(harness, "agent_end", assistantEvent("Main result"));
    await emit(harness, "agent_end", assistantErrorEvent(errorMessage, "Partial retrospective prose"));
    assert.equal(fs.existsSync(paths.resultPath), false);
    await emit(harness, "agent_settled", {});
    const result = finalResult(paths, "retrospective-retry-worker");
    assert.equal(result.result, "Main result");
    assert.equal(result.isError, false);
    assert.equal(result.retrospective, `retrospective unavailable: worker run ended without a result. ${errorMessage}`);
    assert.equal(harness.shutdowns, 1);
  });
}

test("cancelled retrospective preserves the main result", async (t) => {
  const { harness, paths } = await started(t, "cancelled-retrospective-worker");
  await emit(harness, "agent_end", assistantEvent("Main result"));
  await failSettled(harness);
  const result = finalResult(paths, "cancelled-retrospective-worker");
  assert.equal(result.result, "Main result");
  assert.equal(result.retrospective, "retrospective unavailable: worker run ended without a result. Operation aborted by user");
  assert.equal(harness.shutdowns, 1);
});

test("an unfinished retrospective preserves the result when the run settles", async (t) => {
  const { harness, paths } = await started(t, "empty-retrospective");
  await emit(harness, "agent_end", assistantEvent("Saved main result"));
  await emit(harness, "agent_end", { messages: [] });
  assert.equal(fs.existsSync(paths.resultPath), false);
  await emit(harness, "agent_settled", {});
  const result = finalResult(paths, "empty-retrospective");
  assert.equal(result.result, "Saved main result");
  assert.equal(result.isError, false);
  assert.match(result.retrospective ?? "", /retrospective unavailable/);
  assert.equal(harness.shutdowns, 1);
});

for (const [label, event] of [
  ["no assistant message", { messages: [] }],
  ["a terminating tool batch", { messages: [{ role: "assistant", content: [{ type: "toolCall", id: "terminate", name: "test", arguments: {} }], stopReason: "toolUse" }] }],
] as const) {
  test(`a worker ending with ${label} waits after settlement and can return`, async (t) => {
    const { harness, paths } = await started(t, "unfinished");
    await emit(harness, "agent_end", event);
    assert.equal(state(paths), "running");
    await emit(harness, "agent_settled", {});
    assert.equal(state(paths), "waiting");
    assert.equal(fs.existsSync(paths.resultPath), false);
    await runCommand(harness, "worker-return", "Recovered manually");
    assert.equal(finalResult(paths, "unfinished").result, "Recovered manually");
  });
}

test("exhausted overflow recovery waits only at settlement", async (t) => {
  const { harness, paths } = await started(t, "overflow-exhausted");
  await emit(harness, "agent_end", assistantErrorEvent("input exceeds the context window"));
  assert.equal(fs.existsSync(paths.resultPath), false);
  await emit(harness, "agent_settled", {});
  assert.equal(state(paths), "waiting");
  assert.match(reason(paths) ?? "", /context window/);
  assert.equal(harness.shutdowns, 0);
});

test("model setup errors produce a matching failure instead of stranding the parent", async (t) => {
  const harness = createHarness();
  const paths = request(t, "model-error");
  harness.modelFailure = new Error("Model initialization failed");
  await runCommand(harness, "worker-run", paths.requestPath);
  const result = finalResult(paths, "model-error");
  assert.equal(result.isError, true);
  assert.match(result.result, /Model initialization failed/);
  assert.equal(state(paths), "closed");
  assert.deepEqual(harness.sentMessages, []);
});

test("worker-return needs an active request and something to return", async (t) => {
  const harness = createHarness();
  await runCommand(harness, "worker-return", "text");
  assert.match(harness.notifications.at(-1) ?? "", /No active worker request/);

  const paths = request(t, "nothing-to-return");
  await runCommand(harness, "worker-run", paths.requestPath);
  let aborts = 0;
  harness.context.isIdle = () => false;
  harness.context.abort = () => { aborts++; };
  await runCommand(harness, "worker-return", "   ");
  assert.match(harness.notifications.at(-1) ?? "", /Nothing to return yet/);
  assert.equal(aborts, 0, "a refused return leaves work running");
  assert.equal(state(paths), "running");
  assert.equal(fs.existsSync(paths.resultPath), false);
});

test("typed messages reach the parent as positioned guidance, leading the result", async (t) => {
  const { harness, paths } = await started(t, "guided");
  await emit(harness, "message_end", { message: assistantMessage("One") });
  await emit(harness, "message_end", { message: assistantMessage("Two") });
  await emit(harness, "input", { text: "What are you doing?\nBe brief.", source: "rpc" });
  await emit(harness, "input", { text: "machine prompt", source: "extension" });
  await emit(harness, "message_end", { message: assistantMessage("Three") });
  await emit(harness, "input", { text: "Keep going", source: "interactive" });
  await emit(harness, "agent_end", assistantEvent("Final reply"));
  await emit(harness, "agent_end", assistantEvent("everything was ok"));
  const result = finalResult(paths, "guided");
  assert.deepEqual(result.guidance, [{ position: 2, text: "What are you doing?\nBe brief." }, { position: 3, text: "Keep going" }]);
  assert.equal(result.result, "Final reply");
  const formatted = formatWorkerResult(result);
  assert.match(formatted, /^> User guidance: .* of 3\. If the result below does not finish the task/);
  assert.match(formatted, /\n\[2\] What are you doing\?\n {4}Be brief\.\n\[3\] Keep going\n\nFinal reply\n\n---\n\nRetrospective:\neverything was ok$/);
});

test("a run without human input has no guidance, and an early hand-back is listed", async (t) => {
  const { harness, paths } = await started(t, "plain");
  await emit(harness, "agent_end", assistantEvent("Final reply"));
  await emit(harness, "agent_end", assistantEvent("everything was ok"));
  const plain = finalResult(paths, "plain");
  assert.equal(plain.guidance, undefined);
  assert.equal(formatWorkerResult(plain), "Final reply\n\n---\n\nRetrospective:\neverything was ok");

  const early = await started(t, "early");
  await emit(early.harness, "message_end", { message: assistantMessage("Partial work") });
  await runCommand(early.harness, "worker-return");
  const result = finalResult(early.paths, "early");
  assert.equal(result.result, "Partial work");
  assert.deepEqual(result.guidance, [{ position: 1, text: "Handed back early with /worker-return; the worker did not finish on its own." }]);
});

test("worker-return hands back the latest reply of this run, or explicit text instead", async (t) => {
  for (const [text, expected] of [["", "Latest reply"], ['"Explicit text"', "Explicit text"]] as const) {
    const { harness, paths } = await started(t, "returned");
    await emit(harness, "message_end", { message: assistantMessage("First reply") });
    await emit(harness, "message_end", { message: assistantMessage("Latest reply") });
    await emit(harness, "message_end", { message: { role: "assistant", content: [{ type: "toolCall", id: "tool", name: "read", arguments: {} }] } });
    await emit(harness, "message_end", { message: { role: "user", content: "Human text" } });
    await runCommand(harness, "worker-return", text);
    const result = finalResult(paths, "returned");
    assert.equal(result.result, expected);
    assert.equal(result.retrospective, undefined);
    assert.equal(result.isError, false);
    assert.equal(state(paths), "closed");
    assert.equal(harness.shutdowns, 1);
    assert.equal(harness.sentMessages.length, 1, "no model retrospective");
  }
});

test("worker-return stops current work and holds completion while abort and settlement drain", async (t) => {
  const { harness, paths } = await started(t, "busy-return");
  let releaseIdle: (() => void) | undefined;
  let aborts = 0;
  harness.context.isIdle = () => false;
  harness.waitForIdle = () => new Promise<void>((resolve) => { releaseIdle = resolve; });
  harness.context.abort = async () => {
    aborts++;
    await emit(harness, "agent_end", assistantEvent("A reply that must not start a retrospective"));
    await emit(harness, "agent_end", assistantAbortEvent());
    await emit(harness, "agent_settled", {});
  };
  const returning = runCommand(harness, "worker-return", "Manual result");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(aborts, 1);
  assert.equal(fs.existsSync(paths.resultPath), false, "abort must settle before the result");
  assert.notEqual(state(paths), "waiting");
  await runCommand(harness, "worker-return", "Conflicting result");
  assert.match(harness.notifications.at(-1) ?? "", /already returning/);
  releaseIdle?.();
  await returning;
  assert.equal(finalResult(paths, "busy-return").result, "Manual result");
  assert.equal(harness.sentMessages.length, 1);
  assert.equal(harness.shutdowns, 1);
});

test("in the retrospective the main result is immutable; text becomes the retrospective", async (t) => {
  for (const [text, retrospective] of [["Manual retrospective", "Manual retrospective"], ["", undefined]] as const) {
    const { harness, paths } = await started(t, "return-retrospective");
    await emit(harness, "agent_end", assistantEvent("Immutable result"));
    await runCommand(harness, "worker-return", text);
    const result = finalResult(paths, "return-retrospective");
    assert.equal(result.result, "Immutable result");
    assert.equal(result.retrospective, retrospective);
    assert.equal(fs.readFileSync(paths.resultMarkdownPath, "utf8"), "Immutable result");
    await emit(harness, "agent_end", assistantEvent("Late retrospective"));
    assert.equal(harness.shutdowns, 1);
  }
});

test("returning during asynchronous model selection cannot restart a completed request", async (t) => {
  const harness = createHarness();
  const paths = request(t, "model-pending");
  let releaseModel!: () => void;
  harness.modelReady = new Promise<void>((resolve) => { releaseModel = resolve; });
  t.after(() => releaseModel());
  const startup = runCommand(harness, "worker-run", paths.requestPath);
  await Promise.resolve();
  await runCommand(harness, "worker-return", "Recovered during startup");
  releaseModel();
  await startup;
  assert.equal(finalResult(paths, "model-pending").result, "Recovered during startup");
  assert.deepEqual(harness.sentMessages, []);
  assert.equal(state(paths), "closed");
  assert.deepEqual(harness.recoveryPolicies, [true], "finishing main work does not disable later provider recovery");
});

for (const abortFailure of ["sync", "async"] as const) {
  test(`a return whose abort fails (${abortFailure}) releases ownership`, async (t) => {
    const { harness, paths } = await started(t, "return-abort-failure");
    harness.context.isIdle = () => false;
    harness.context.abort = () => {
      if (abortFailure === "sync") throw new Error("fixture cancellation failed");
      return Promise.reject(new Error("fixture cancellation failed"));
    };
    await assert.rejects(runCommand(harness, "worker-return", "Manual result"), /fixture cancellation failed/);
    assert.equal(fs.existsSync(paths.resultPath), false);
    harness.context.isIdle = () => true;
    await emit(harness, "agent_end", assistantEvent("Normal completion still works"));
    assert.equal(state(paths), "retrospective");
  });
}

test("a return overtaken by shutdown publishes nothing", async (t) => {
  const { harness, paths } = await started(t, "retired-return");
  let releaseIdle: (() => void) | undefined;
  harness.waitForIdle = () => new Promise<void>((resolve) => { releaseIdle = resolve; });
  const returning = runCommand(harness, "worker-return", "Manual result");
  await emit(harness, "session_shutdown", {});
  releaseIdle?.();
  await returning;
  assert.equal(fs.existsSync(paths.resultPath), false);
  assert.match(harness.notifications.at(-1) ?? "", /no longer active/);
});

for (const outcome of ["resumed", "failed", "unmatched", "errored-result", "aborted"] as const) {
  test(`compaction handoffs preserve only matching intentional termination: ${outcome}`, async (t) => {
    const { harness, paths } = await started(t, "handoff");
    const handoff = (event: SelfCompactHandoff) => harness.events.emit(SELF_COMPACT_HANDOFF_EVENT, event);
    handoff({ state: "pending", toolCallId: "compact" });
    const id = outcome === "unmatched" ? "another-tool" : "compact";
    await failSettled(harness, outcome === "aborted" ? assistantAbortEvent() : {
      messages: [
        { role: "assistant", content: [{ type: "toolCall", id, name: "self_compact", arguments: {} }], stopReason: "toolUse" },
        { role: "toolResult", toolCallId: id, isError: outcome === "errored-result", content: [] },
      ],
    });
    if (["unmatched", "errored-result", "aborted"].includes(outcome)) {
      assert.equal(state(paths), "waiting");
      handoff({ state: "resumed", toolCallId: "compact" });
      assert.equal(state(paths), "waiting");
      return;
    }
    assert.equal(state(paths), "running");
    // Unrelated callbacks cannot resolve or fail this request's handoff.
    handoff({ state: "failed", toolCallId: "stale", reason: "Stale failure" });
    assert.equal(state(paths), "running");
    if (outcome === "failed") {
      handoff({ state: "failed", toolCallId: "compact", reason: "Compaction cancelled" });
      assert.equal(state(paths), "waiting");
      assert.match(reason(paths) ?? "", /Compaction cancelled/);
      handoff({ state: "resumed", toolCallId: "compact" });
      assert.equal(state(paths), "waiting");
      return;
    }
    handoff({ state: "resumed", toolCallId: "compact" });
    await emit(harness, "agent_end", assistantEvent("Final result"));
    await emit(harness, "agent_end", assistantEvent("everything was ok"));
    assert.equal(finalResult(paths, "handoff").result, "Final result");
    assert.equal(harness.shutdowns, 1);
  });
}

test("worker shutdown detaches handoff listeners and ignores late callbacks", async (t) => {
  const { harness, paths } = await started(t, "shutdown");
  harness.events.emit(SELF_COMPACT_HANDOFF_EVENT, { state: "pending", toolCallId: "compact" } satisfies SelfCompactHandoff);
  await emit(harness, "session_shutdown", {});
  harness.events.emit(SELF_COMPACT_HANDOFF_EVENT, { state: "failed", toolCallId: "compact", reason: "Late failure" } satisfies SelfCompactHandoff);
  assert.equal(state(paths), "running");
  assert.equal(harness.notifications.length, 0);
});

test("provider recovery status preserves automatic work, follows only this session, and clears without a new prompt", async (t) => {
  const { harness, paths } = await started(t, "quota-wait");
  const retryAt = Date.now() + 60_000;
  const report = (data: unknown) => harness.events.emit("pi-claude-agent:recovery-status", data);
  assert.deepEqual(harness.recoveryPolicies, [true]);
  for (const data of [null, {}, { sessionId: "another", retryAt }, { sessionId: "worker-frame-test", retryAt: NaN }, { sessionId: "worker-frame-test", retryAt: -1 }]) report(data);
  assert.equal(readWorkerStatus(paths.statusPath)?.retryAt, undefined);
  report({ sessionId: "worker-frame-test", retryAt });
  assert.equal(state(paths), "running");
  assert.equal(readWorkerStatus(paths.statusPath)?.retryAt, retryAt);
  assert.equal(harness.statuses.get("worker-frame"), "worker:quota-wait");
  assert.ok(harness.widgets.get("worker-frame")?.join("\n").includes(formatWorkerRetryTime(retryAt)));
  await emit(harness, "turn_end", {});
  assert.equal(readWorkerStatus(paths.statusPath)?.retryAt, retryAt);
  report({ sessionId: "another" });
  assert.equal(readWorkerStatus(paths.statusPath)?.retryAt, retryAt);
  report({ sessionId: "worker-frame-test", retryAt: retryAt + 20_000 });
  assert.equal(readWorkerStatus(paths.statusPath)?.retryAt, retryAt + 20_000);
  report({ sessionId: "worker-frame-test" });
  assert.equal(readWorkerStatus(paths.statusPath)?.retryAt, undefined);
  assert.equal(harness.statuses.get("worker-frame"), "worker:running");
  assert.equal(harness.widgets.get("worker-frame"), undefined);
  assert.equal(harness.sentMessages.length, 1, "recovery status never injects a continuation message");
  assert.equal(fs.existsSync(paths.resultPath), false);
  await emit(harness, "agent_end", assistantEvent("Recovered main result"));
  assert.equal(harness.sentRecoveryPolicies.at(-1), false, "retrospective inference must fail fast");
  report({ sessionId: "worker-frame-test", retryAt });
  assert.equal(readWorkerStatus(paths.statusPath)?.retryAt, undefined);
  await failSettled(harness, assistantErrorEvent("Claude five-hour subscription limit reached"));
  const result = finalResult(paths, "quota-wait");
  assert.equal(result.result, "Recovered main result");
  assert.equal(result.isError, false);
  assert.match(result.retrospective ?? "", /retrospective unavailable/);
});

test("escaping a quota wait waits for the human; the next run keeps quota recovery", async (t) => {
  const { harness, paths } = await started(t, "quota-escape");
  const retryAt = Date.now() + 60_000;
  const report = (deadline?: number) => harness.events.emit("pi-claude-agent:recovery-status", { sessionId: "worker-frame-test", retryAt: deadline });
  report(retryAt);
  report();
  await failSettled(harness);
  assert.equal(state(paths), "waiting");
  assert.equal(readWorkerStatus(paths.statusPath)?.retryAt, undefined);
  assert.equal(harness.recoveryPolicies.at(-1), true);

  await emit(harness, "agent_start", {});
  report(retryAt + 20_000);
  assert.equal(state(paths), "running");
  assert.equal(readWorkerStatus(paths.statusPath)?.retryAt, retryAt + 20_000);
  assert.equal(harness.statuses.get("worker-frame"), "worker:quota-wait");
  assert.equal(harness.recoveryPolicies.at(-1), true);
  assert.equal(harness.sentMessages.length, 1, "quota recovery does not inject guidance");
});

for (const action of ["return", "shutdown"] as const) {
  test(`${action} ends quota reporting without disabling later main-request recovery`, async (t) => {
    const { harness, paths } = await started(t, "quota-end");
    const report = (retryAt?: number) => harness.events.emit("pi-claude-agent:recovery-status", { sessionId: "worker-frame-test", retryAt });
    let aborts = 0;
    report(Date.now() + 60_000);
    harness.context.isIdle = () => false;
    harness.context.abort = async () => {
      aborts++;
      assert.equal(harness.recoveryPolicies.at(-1), true, "explicit abort cancels the request, not a policy change");
      report();
      await failSettled(harness);
    };
    if (action === "shutdown") await emit(harness, "session_shutdown", {});
    else await runCommand(harness, "worker-return", "Human result");
    assert.equal(aborts, action === "shutdown" ? 0 : 1);
    assert.equal(harness.recoveryPolicies.at(-1), true);
    assert.equal(readWorkerStatus(paths.statusPath)?.retryAt, undefined);
    const after = fs.readFileSync(paths.statusPath, "utf8");
    report(Date.now() + 60_000);
    assert.equal(fs.readFileSync(paths.statusPath, "utf8"), after, "retired requests ignore late status");
  });
}

test("result parsing rejects mismatched late requests and malformed artifacts", () => {
  const valid = { id: "late", result: "Stale", timestamp: new Date().toISOString() };
  assert.throws(() => parseWorkerResult(JSON.stringify(valid), "/tmp/result.json", "current"), /id mismatch/);
  assert.throws(() => parseWorkerResult("{", "/tmp/result.json", "current"), /Invalid worker result JSON/);
  assert.throws(() => parseWorkerResult('{"id":"current"}', "/tmp/result.json", "current"), /Invalid worker result shape/);
});
