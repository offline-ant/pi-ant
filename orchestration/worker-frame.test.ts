import assert from "node:assert/strict";
import * as fs from "node:fs";
import test from "node:test";
import { createEventBus, type EventBus } from "@earendil-works/pi-coding-agent";
import { SELF_COMPACT_HANDOFF_EVENT, type SelfCompactHandoff } from "./self-compact-handoff.ts";
import workerFrameExtension, {
  createWorkerArtifacts,
  formatWorkerRetryTime,
  parseWorkerResult,
  readWorkerStatus,
  writeWorkerRequest as writeProtocolRequest,
  type WorkerArtifactPaths,
  type WorkerRequestFile,
} from "./worker-frame.ts";

function writeWorkerRequest(paths: WorkerArtifactPaths, request: Omit<WorkerRequestFile, "model" | "thinkingLevel">): void {
  writeProtocolRequest(paths, { ...request, model: { provider: "fake", id: "fake" }, thinkingLevel: "high" });
}

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
  context: unknown;
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
    context: undefined,
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

  harness.context = {
    abort: () => undefined,
    modelRegistry: { find: (provider: string, id: string) => ({ provider, id }) },
    getContextUsage: () => ({ percent: 12.5 }),
    isIdle: () => true,
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
  };

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

function assistantEvent(text: string): unknown {
  return {
    messages: [{
      role: "assistant",
      content: [{ type: "text", text }],
      stopReason: "stop",
    }],
  };
}

function userMessageStart(text: string): unknown {
  return {
    message: {
      role: "user",
      content: [{ type: "text", text }],
    },
  };
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
  return {
    messages: [{
      role: "assistant",
      content: [],
      stopReason: "aborted",
      errorMessage: "Operation aborted by user",
    }],
  };
}

for (const toolName of ["do", "delegate", "fresh_look"]) {
  test(`${toolName}: worker tools follow the request and only the first immediate subworker call is warned`, async () => {
    const harness = createHarness();
    const paths = createWorkerArtifacts();
    try {
      writeWorkerRequest(paths, {
        id: "nested-worker",
        task: "Investigate the issue",
        tools: ["read", toolName, "unavailable-tool"],
        resultPath: paths.resultPath,
        statusPath: paths.statusPath,
      });

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
    } finally {
      fs.rmSync(paths.artifactDir, { recursive: true, force: true });
    }
  });
}

test("human input supervises result and retrospective capture until explicit submission", async () => {
  const harness = createHarness();
  const paths = createWorkerArtifacts();
  try {
    writeWorkerRequest(paths, {
      id: "supervised-worker",
      task: "Complete the delegated task",
      tools: ["read", "bash"],
      resultPath: paths.resultPath,
      statusPath: paths.statusPath,
    });

    await runCommand(harness, "worker-run", paths.requestPath);
    assert.equal(readWorkerStatus(paths.statusPath)?.state, "running");
    assert.equal(harness.sentMessages.length, 1);
    assert.match(harness.sentMessages[0] ?? "", /parent-facing result or blocker/);
    assert.match(harness.sentMessages[0] ?? "", /Complete the delegated task/);

    await emit(harness, "input", { source: "interactive", text: "Let us discuss this first" });
    assert.equal(readWorkerStatus(paths.statusPath)?.state, "supervised");
    assert.match(harness.statuses.get("worker-frame") ?? "", /supervised/);

    const contextHandler = harness.handlers.get("context")?.[0];
    if (!contextHandler) throw new Error("No context handler registered");
    const contextResult = await contextHandler({ messages: [] }, harness.context) as { messages: Array<{ customType?: string; content?: string }> };
    assert.equal(contextResult.messages.at(-1)?.customType, "pi-orchestration:supervision");
    assert.match(contextResult.messages.at(-1)?.content ?? "", /Respond normally/);

    await emit(harness, "agent_end", assistantEvent("Discussion reply"));
    assert.equal(fs.existsSync(paths.resultPath), false);
    assert.match(harness.widgets.get("worker-frame")?.join("\n") ?? "", /ready to submit/);

    await runCommand(harness, "worker-submit");
    assert.equal(fs.readFileSync(paths.resultMarkdownPath, "utf8"), "Discussion reply");
    assert.equal(readWorkerStatus(paths.statusPath)?.state, "retrospective");
    assert.deepEqual(harness.activeTools, ["read", "bash"]);
    assert.equal(harness.sentMessages.length, 2);

    await emit(harness, "input", { source: "interactive", text: "One more question" });
    assert.equal(readWorkerStatus(paths.statusPath)?.state, "supervised");
    assert.deepEqual(harness.activeTools, ["read", "bash"]);

    await emit(harness, "agent_end", assistantEvent("Outdated retrospective candidate"));
    await emit(harness, "input", { source: "interactive", text: "Please revise that" });
    assert.doesNotMatch(harness.widgets.get("worker-frame")?.join("\n") ?? "", /ready to submit/);
    await runCommand(harness, "worker-submit");
    assert.equal(fs.existsSync(paths.resultPath), false);

    await emit(harness, "agent_end", assistantEvent("Human-guided retrospective"));
    await runCommand(harness, "worker-submit");

    const result = parseWorkerResult(fs.readFileSync(paths.resultPath, "utf8"), paths.resultPath, "supervised-worker");
    assert.equal(result.result, "Discussion reply");
    assert.equal(result.retrospective, "Human-guided retrospective");
    assert.deepEqual(harness.activeTools, ["read", "bash"]);
    assert.equal(harness.shutdowns, 1);
  } finally {
    fs.rmSync(paths.artifactDir, { recursive: true, force: true });
  }
});

test("worker-continue gives guidance and restores automatic result capture", async () => {
  const harness = createHarness();
  const paths = createWorkerArtifacts();
  try {
    writeWorkerRequest(paths, {
      id: "continued-worker",
      task: "Complete with guidance",
      tools: ["read", "bash"],
      resultPath: paths.resultPath,
      statusPath: paths.statusPath,
    });

    await runCommand(harness, "worker-run", paths.requestPath);
    await emit(harness, "input", { source: "interactive", text: "Let us discuss the approach" });
    await emit(harness, "agent_end", assistantEvent("Outdated supervised reply"));
    assert.equal(readWorkerStatus(paths.statusPath)?.state, "supervised");

    await runCommand(harness, "worker-continue", '"Focus on the integration test, then finish"');
    const continuedStatus = readWorkerStatus(paths.statusPath);
    assert.equal(continuedStatus?.state, "running");
    assert.equal(continuedStatus?.supervisionReason, undefined);
    assert.equal(harness.statuses.get("worker-frame"), "worker:auto");
    assert.equal(harness.widgets.get("worker-frame"), undefined);
    assert.equal(harness.sentMessages.at(-1), "Focus on the integration test, then finish");
    assert.equal(harness.sentDeliveryModes.at(-1), "steer");
    assert.equal(harness.sentRecoveryPolicies.at(-1), true);

    await runCommand(harness, "worker-submit", "Stale result");
    assert.match(harness.notifications.at(-1) ?? "", /guidance is queued/);
    assert.equal(readWorkerStatus(paths.statusPath)?.state, "running");
    await emit(harness, "agent_end", assistantEvent("Pre-guidance automatic reply"));
    assert.equal(readWorkerStatus(paths.statusPath)?.state, "running");
    assert.equal(fs.existsSync(paths.resultMarkdownPath), false);
    await emit(harness, "input", { source: "extension", text: "Focus on the integration test, then finish" });
    await emit(harness, "message_start", userMessageStart("Focus on the integration test, then finish"));
    assert.equal(readWorkerStatus(paths.statusPath)?.state, "running");
    await emit(harness, "agent_end", assistantEvent("Guided automatic result"));
    assert.equal(readWorkerStatus(paths.statusPath)?.state, "retrospective");
    await emit(harness, "agent_end", assistantEvent("everything was ok"));

    const result = parseWorkerResult(fs.readFileSync(paths.resultPath, "utf8"), paths.resultPath, "continued-worker");
    assert.equal(result.result, "Guided automatic result");
    assert.equal(result.retrospective, "everything was ok");
    assert.equal(harness.shutdowns, 1);
  } finally {
    fs.rmSync(paths.artifactDir, { recursive: true, force: true });
  }
});

test("worker-continue preserves the main result while resuming an automatic retrospective", async () => {
  const harness = createHarness();
  const paths = createWorkerArtifacts();
  try {
    writeWorkerRequest(paths, {
      id: "continued-retrospective-worker",
      task: "Complete before retrospective guidance",
      tools: ["read", "bash"],
      resultPath: paths.resultPath,
      statusPath: paths.statusPath,
    });

    await runCommand(harness, "worker-run", paths.requestPath);
    await emit(harness, "agent_end", assistantEvent("Saved main result"));
    await emit(harness, "input", { source: "interactive", text: "Explain that observation" });
    assert.equal(readWorkerStatus(paths.statusPath)?.state, "supervised");
    assert.deepEqual(harness.activeTools, ["read", "bash"]);
    await emit(harness, "agent_end", assistantEvent("Outdated retrospective reply"));

    await runCommand(harness, "worker-continue", "Include only the important observation");
    assert.equal(readWorkerStatus(paths.statusPath)?.state, "retrospective");
    assert.deepEqual(harness.activeTools, ["read", "bash"]);
    assert.equal(harness.sentMessages.at(-1), "Include only the important observation");
    assert.equal(harness.sentDeliveryModes.at(-1), "steer");
    assert.equal(harness.sentRecoveryPolicies.at(-1), false);
    await emit(harness, "message_start", userMessageStart("Include only the important observation"));
    await emit(harness, "agent_end", assistantEvent("Important guided observation"));

    const result = parseWorkerResult(
      fs.readFileSync(paths.resultPath, "utf8"),
      paths.resultPath,
      "continued-retrospective-worker",
    );
    assert.equal(result.result, "Saved main result");
    assert.equal(result.retrospective, "Important guided observation");
    assert.equal(harness.shutdowns, 1);
  } finally {
    fs.rmSync(paths.artifactDir, { recursive: true, force: true });
  }
});

test("worker-continue clears quota failures, supervises repeated rejection and permits recovery", async () => {
  const harness = createHarness();
  const paths = createWorkerArtifacts();
  try {
    writeWorkerRequest(paths, {
      id: "continued-failure-worker",
      task: "Recover with guidance",
      tools: ["read", "bash"],
      resultPath: paths.resultPath,
      statusPath: paths.statusPath,
    });

    await runCommand(harness, "worker-run", paths.requestPath);
    await emit(harness, "agent_end", assistantErrorEvent("429 quota exceeded"));
    await emit(harness, "agent_settled", {});
    assert.equal(readWorkerStatus(paths.statusPath)?.state, "supervised");
    assert.match(readWorkerStatus(paths.statusPath)?.supervisionReason ?? "", /quota exceeded/);

    await runCommand(harness, "worker-continue", "Retry using the existing evidence");
    const continuedStatus = readWorkerStatus(paths.statusPath);
    assert.equal(continuedStatus?.state, "running");
    assert.equal(continuedStatus?.supervisionReason, undefined);
    await emit(harness, "agent_end", assistantErrorEvent("Pre-guidance quota exceeded"));
    await emit(harness, "agent_settled", {});
    assert.equal(readWorkerStatus(paths.statusPath)?.state, "running");
    assert.equal(fs.existsSync(paths.resultPath), false);
    await emit(harness, "message_start", userMessageStart("Retry using the existing evidence"));
    await emit(harness, "agent_end", assistantErrorEvent("Both Claude accounts exhausted: quota exceeded"));
    assert.equal(readWorkerStatus(paths.statusPath)?.state, "running");
    await emit(harness, "agent_settled", {});
    assert.equal(readWorkerStatus(paths.statusPath)?.state, "supervised");
    assert.match(readWorkerStatus(paths.statusPath)?.supervisionReason ?? "", /Both Claude accounts exhausted/);
    assert.equal(fs.existsSync(paths.resultPath), false);
    assert.equal(harness.shutdowns, 0);

    await runCommand(harness, "worker-continue", "Continue with the available model");
    assert.equal(readWorkerStatus(paths.statusPath)?.supervisionReason, undefined);
    await emit(harness, "message_start", userMessageStart("Continue with the available model"));
    await emit(harness, "agent_end", assistantEvent("Recovered automatically"));
    await emit(harness, "agent_settled", {});
    assert.equal(readWorkerStatus(paths.statusPath)?.state, "retrospective");
    await emit(harness, "agent_end", assistantEvent("everything was ok"));
    const result = parseWorkerResult(
      fs.readFileSync(paths.resultPath, "utf8"),
      paths.resultPath,
      "continued-failure-worker",
    );
    assert.equal(result.result, "Recovered automatically");
    assert.equal(result.isError, false);
  } finally {
    fs.rmSync(paths.artifactDir, { recursive: true, force: true });
  }
});

test("worker-continue does not race a pending worker submission", async () => {
  const harness = createHarness();
  const paths = createWorkerArtifacts();
  let releaseIdle: (() => void) | undefined;
  try {
    writeWorkerRequest(paths, {
      id: "continue-submit-race-worker",
      task: "Wait for submission",
      tools: ["read", "bash"],
      resultPath: paths.resultPath,
      statusPath: paths.statusPath,
    });
    await runCommand(harness, "worker-run", paths.requestPath);
    harness.waitForIdle = () => new Promise<void>((resolve) => {
      releaseIdle = resolve;
    });

    const submission = runCommand(harness, "worker-submit", "Submitted result");
    await Promise.resolve();
    await runCommand(harness, "worker-continue", "Conflicting guidance");
    assert.match(harness.notifications.at(-1) ?? "", /submission is already waiting/);
    assert.equal(harness.sentMessages.length, 1);

    releaseIdle?.();
    await submission;
    assert.equal(readWorkerStatus(paths.statusPath)?.state, "retrospective");
  } finally {
    fs.rmSync(paths.artifactDir, { recursive: true, force: true });
  }
});

test("worker-continue requires an active request and guidance prompt", async () => {
  const harness = createHarness();
  await runCommand(harness, "worker-continue", "guidance");
  assert.match(harness.notifications.at(-1) ?? "", /No active worker request/);
  assert.equal(harness.sentMessages.length, 0);

  const paths = createWorkerArtifacts();
  try {
    writeWorkerRequest(paths, {
      id: "continue-validation-worker",
      task: "Wait for valid guidance",
      tools: ["read", "bash"],
      resultPath: paths.resultPath,
      statusPath: paths.statusPath,
    });
    await runCommand(harness, "worker-run", paths.requestPath);
    await runCommand(harness, "worker-continue", "   ");
    assert.match(harness.notifications.at(-1) ?? "", /Usage: \/worker-continue <prompt>/);
    assert.equal(harness.sentMessages.length, 1);
    assert.equal(readWorkerStatus(paths.statusPath)?.state, "running");
  } finally {
    fs.rmSync(paths.artifactDir, { recursive: true, force: true });
  }
});

test("extension messages preserve automatic result capture", async () => {
  const harness = createHarness();
  const paths = createWorkerArtifacts();
  try {
    writeWorkerRequest(paths, {
      id: "automatic-worker",
      task: "Complete automatically",
      tools: ["read", "bash"],
      resultPath: paths.resultPath,
      statusPath: paths.statusPath,
    });

    await runCommand(harness, "worker-run", paths.requestPath);
    await emit(harness, "input", { source: "extension", text: "internal worker prompt" });
    assert.equal(readWorkerStatus(paths.statusPath)?.state, "running");

    await emit(harness, "agent_end", assistantEvent("Automatic result"));
    assert.equal(readWorkerStatus(paths.statusPath)?.state, "retrospective");
    await emit(harness, "agent_end", assistantEvent("everything was ok"));

    const result = parseWorkerResult(fs.readFileSync(paths.resultPath, "utf8"), paths.resultPath, "automatic-worker");
    assert.equal(result.result, "Automatic result");
    assert.equal(result.retrospective, "everything was ok");
    assert.equal(harness.shutdowns, 1);
    assert.deepEqual(harness.sentRecoveryPolicies, [true, false], "publish the policy before each internal prompt");
    assert.equal(harness.recoveryPolicies.at(-1), true, "completed work leaves provider recovery at its default");
  } finally {
    fs.rmSync(paths.artifactDir, { recursive: true, force: true });
  }
});

test("retryable result failure enters supervision only after retries settle", async () => {
  const harness = createHarness();
  const paths = createWorkerArtifacts();
  try {
    writeWorkerRequest(paths, {
      id: "retry-worker",
      task: "Recover after connection failure",
      tools: ["read", "bash"],
      resultPath: paths.resultPath,
      statusPath: paths.statusPath,
    });

    await runCommand(harness, "worker-run", paths.requestPath);
    await emit(harness, "agent_end", assistantErrorEvent("Connection error."));
    assert.equal(readWorkerStatus(paths.statusPath)?.state, "running");
    assert.equal(fs.existsSync(paths.resultPath), false);

    await emit(harness, "agent_end", assistantErrorEvent("Connection error."));
    await emit(harness, "agent_settled", {});

    const supervisedStatus = readWorkerStatus(paths.statusPath);
    assert.equal(supervisedStatus?.state, "supervised");
    assert.match(supervisedStatus?.supervisionReason ?? "", /Automatic worker run ended without a result: Connection error/);
    assert.equal(fs.existsSync(paths.resultPath), false);
    assert.equal(harness.shutdowns, 0);

    await runCommand(harness, "worker-submit");
    assert.match(
      readWorkerStatus(paths.statusPath)?.supervisionReason ?? "",
      /Automatic worker run ended without a result: Connection error/,
    );
    assert.equal(fs.existsSync(paths.resultPath), false);

    await emit(harness, "input", { source: "interactive", text: "Retry now" });
    assert.equal(readWorkerStatus(paths.statusPath)?.supervisionReason, undefined);
    await emit(harness, "agent_end", assistantEvent("Recovered result"));
    await runCommand(harness, "worker-submit");
    await emit(harness, "agent_end", assistantEvent("everything was ok"));

    const result = parseWorkerResult(fs.readFileSync(paths.resultPath, "utf8"), paths.resultPath, "retry-worker");
    assert.equal(result.result, "Recovered result");
    assert.equal(result.retrospective, "everything was ok");
    assert.equal(harness.shutdowns, 1);
  } finally {
    fs.rmSync(paths.artifactDir, { recursive: true, force: true });
  }
});

for (const errorMessage of ["Connection error.", "429 quota exceeded"]) {
  test(`retrospective failure preserves the main result after settlement: ${errorMessage}`, async () => {
    const harness = createHarness();
    const paths = createWorkerArtifacts();
    try {
      writeWorkerRequest(paths, {
        id: "retrospective-retry-worker",
        task: "Complete before retrospective failure",
        tools: ["read", "bash"],
        resultPath: paths.resultPath,
        statusPath: paths.statusPath,
      });

      await runCommand(harness, "worker-run", paths.requestPath);
      await emit(harness, "agent_end", assistantEvent("Main result"));
      await emit(harness, "agent_end", assistantErrorEvent(errorMessage, "Partial retrospective prose"));
      assert.equal(fs.existsSync(paths.resultPath), false);
      await emit(harness, "agent_settled", {});

      const result = parseWorkerResult(
        fs.readFileSync(paths.resultPath, "utf8"),
        paths.resultPath,
        "retrospective-retry-worker",
      );
      assert.equal(result.result, "Main result");
      assert.equal(result.isError, false);
      assert.equal(result.retrospective, `retrospective unavailable: automatic worker run ended without a result. ${errorMessage}`);
      assert.equal(harness.shutdowns, 1);
    } finally {
      fs.rmSync(paths.artifactDir, { recursive: true, force: true });
    }
  });
}

test("cancelled result enters supervision after the worker run settles", async () => {
  const harness = createHarness();
  const paths = createWorkerArtifacts();
  try {
    writeWorkerRequest(paths, {
      id: "cancelled-worker",
      task: "Wait for cancellation",
      tools: ["read", "bash"],
      resultPath: paths.resultPath,
      statusPath: paths.statusPath,
    });

    await runCommand(harness, "worker-run", paths.requestPath);
    await emit(harness, "agent_end", assistantAbortEvent());
    await emit(harness, "agent_settled", {});

    const status = readWorkerStatus(paths.statusPath);
    assert.equal(status?.state, "supervised");
    assert.match(status?.supervisionReason ?? "", /Operation aborted by user/);
    assert.equal(fs.existsSync(paths.resultPath), false);
    assert.equal(harness.shutdowns, 0);
  } finally {
    fs.rmSync(paths.artifactDir, { recursive: true, force: true });
  }
});

test("cancelled retrospective preserves the main result", async () => {
  const harness = createHarness();
  const paths = createWorkerArtifacts();
  try {
    writeWorkerRequest(paths, {
      id: "cancelled-retrospective-worker",
      task: "Complete before retrospective cancellation",
      tools: ["read", "bash"],
      resultPath: paths.resultPath,
      statusPath: paths.statusPath,
    });

    await runCommand(harness, "worker-run", paths.requestPath);
    await emit(harness, "agent_end", assistantEvent("Main result"));
    await emit(harness, "agent_end", assistantAbortEvent());
    await emit(harness, "agent_settled", {});

    const result = parseWorkerResult(
      fs.readFileSync(paths.resultPath, "utf8"),
      paths.resultPath,
      "cancelled-retrospective-worker",
    );
    assert.equal(result.result, "Main result");
    assert.equal(
      result.retrospective,
      "retrospective unavailable: automatic worker run ended without a result. Operation aborted by user",
    );
    assert.equal(harness.shutdowns, 1);
  } finally {
    fs.rmSync(paths.artifactDir, { recursive: true, force: true });
  }
});

for (const errorMessage of [
  "429 quota exceeded",
  "Claude five-hour subscription limit reached",
  "401 authentication failed",
  "Unrecognized provider failure",
]) {
  test(`unresolved assistant error supervises only after settlement: ${errorMessage}`, async () => {
    const harness = createHarness();
    const paths = createWorkerArtifacts();
    try {
      writeWorkerRequest(paths, {
        id: "failed-inference-worker",
        task: "Preserve the worker for manual recovery",
        tools: ["read", "bash"],
        resultPath: paths.resultPath,
        statusPath: paths.statusPath,
      });

      await runCommand(harness, "worker-run", paths.requestPath);
      await emit(harness, "agent_end", assistantErrorEvent(errorMessage, "Partial assistant prose"));
      assert.equal(readWorkerStatus(paths.statusPath)?.state, "running");
      assert.equal(harness.widgets.get("worker-frame"), undefined);
      assert.equal(fs.existsSync(paths.resultPath), false);
      await emit(harness, "agent_settled", {});
      await emit(harness, "agent_settled", {});

      const status = readWorkerStatus(paths.statusPath);
      assert.equal(status?.state, "supervised");
      assert.equal(status?.supervisionReason, `Automatic worker run ended without a result: ${errorMessage}`);
      assert.equal(harness.statuses.get("worker-frame"), "worker:supervised");
      assert.match(harness.widgets.get("worker-frame")?.join("\n") ?? "", /worker-continue/);
      assert.doesNotMatch(harness.widgets.get("worker-frame")?.join("\n") ?? "", /Partial assistant prose/);
      assert.match(harness.notifications.at(-1) ?? "", /The worker is now supervised/);
      assert.equal(fs.existsSync(paths.resultPath), false);
      assert.equal(fs.existsSync(paths.resultMarkdownPath), false);
      assert.equal(harness.shutdowns, 0);
      assert.equal(harness.sentMessages.length, 1);

      await runCommand(harness, "finish-worker-now", "Stopped by the human while the provider was unavailable");
      const result = parseWorkerResult(fs.readFileSync(paths.resultPath, "utf8"), paths.resultPath, "failed-inference-worker");
      assert.equal(result.result, "Stopped by the human while the provider was unavailable");
      assert.equal(result.isError, false);
      assert.equal(harness.sentMessages.length, 1);
      assert.equal(harness.shutdowns, 1);
    } finally {
      fs.rmSync(paths.artifactDir, { recursive: true, force: true });
    }
  });
}

for (const errorMessage of [
  "Connection error.",
  "429 quota exceeded",
  "500 server error: input exceeds the context window",
]) {
  test(`successful recovery before settlement preserves automatic completion: ${errorMessage}`, async () => {
    const harness = createHarness();
    const paths = createWorkerArtifacts();
    try {
      writeWorkerRequest(paths, {
        id: "recovered-worker",
        task: "Recover through provider failover, retry or compaction",
        tools: ["read", "bash"],
        resultPath: paths.resultPath,
        statusPath: paths.statusPath,
      });

      await runCommand(harness, "worker-run", paths.requestPath);
      await emit(harness, "agent_end", assistantErrorEvent(errorMessage));
      assert.equal(readWorkerStatus(paths.statusPath)?.state, "running");
      assert.equal(fs.existsSync(paths.resultPath), false);

      await emit(harness, "agent_end", assistantEvent("Recovered automatically"));
      await emit(harness, "agent_settled", {});
      assert.equal(readWorkerStatus(paths.statusPath)?.state, "retrospective");
      assert.equal(readWorkerStatus(paths.statusPath)?.supervisionReason, undefined);
      assert.equal(harness.notifications.length, 0);
      await emit(harness, "agent_end", assistantEvent("everything was ok"));
      await emit(harness, "agent_settled", {});

      const result = parseWorkerResult(fs.readFileSync(paths.resultPath, "utf8"), paths.resultPath, "recovered-worker");
      assert.equal(result.result, "Recovered automatically");
      assert.equal(result.isError, false);
      assert.equal(result.retrospective, "everything was ok");
      assert.equal(harness.shutdowns, 1);
    } finally {
      fs.rmSync(paths.artifactDir, { recursive: true, force: true });
    }
  });
}

test("RPC busy prompts supervise immediately, before an assistant reply can complete the worker", async () => {
  const harness = createHarness();
  const paths = createWorkerArtifacts();
  try {
    writeWorkerRequest(paths, { id: "rpc-supervision", task: "Work", tools: ["read"], resultPath: paths.resultPath, statusPath: paths.statusPath });
    await runCommand(harness, "worker-run", paths.requestPath);
    await emit(harness, "input", { source: "rpc", text: "Discuss first", streamingBehavior: "followUp" });
    await emit(harness, "agent_end", assistantEvent("Reply before follow-up"));
    await emit(harness, "agent_settled", {});
    assert.equal(readWorkerStatus(paths.statusPath)?.state, "supervised");
    assert.equal(fs.existsSync(paths.resultPath), false);
  } finally { fs.rmSync(paths.artifactDir, { recursive: true, force: true }); }
});

test("finish-worker-now cannot replace the immutable main result during retrospective", async () => {
  const harness = createHarness();
  const paths = createWorkerArtifacts();
  try {
    writeWorkerRequest(paths, { id: "finish-retrospective", task: "Work", tools: ["read"], resultPath: paths.resultPath, statusPath: paths.statusPath });
    await runCommand(harness, "worker-run", paths.requestPath);
    await emit(harness, "agent_end", assistantEvent("Immutable result"));
    await runCommand(harness, "finish-worker-now", "Manual retrospective");
    const result = parseWorkerResult(fs.readFileSync(paths.resultPath, "utf8"), paths.resultPath, "finish-retrospective");
    assert.equal(result.result, "Immutable result");
    assert.equal(result.retrospective, "Manual retrospective");
    assert.equal(fs.readFileSync(paths.resultMarkdownPath, "utf8"), "Immutable result");
    await emit(harness, "agent_end", assistantEvent("Late retrospective"));
    assert.equal(fs.readFileSync(paths.retrospectiveMarkdownPath, "utf8"), "Manual retrospective");
  } finally { fs.rmSync(paths.artifactDir, { recursive: true, force: true }); }
});

test("finish-worker-now holds completion while abort and settlement events drain", async () => {
  const harness = createHarness();
  const paths = createWorkerArtifacts();
  const context = harness.context as { isIdle(): boolean; abort(): Promise<void> };
  try {
    writeWorkerRequest(paths, { id: "busy-finish", task: "Work", tools: ["read"], resultPath: paths.resultPath, statusPath: paths.statusPath });
    await runCommand(harness, "worker-run", paths.requestPath);
    await emit(harness, "agent_end", assistantEvent("Saved main result"));
    context.isIdle = () => false;
    context.abort = async () => {
      await emit(harness, "agent_end", assistantAbortEvent());
      await emit(harness, "agent_settled", {});
    };
    await runCommand(harness, "finish-worker-now", "Finish despite cancellation");
    const result = parseWorkerResult(fs.readFileSync(paths.resultPath, "utf8"), paths.resultPath, "busy-finish");
    assert.equal(result.result, "Saved main result");
    assert.equal(result.retrospective, "Finish despite cancellation");
    assert.equal(harness.shutdowns, 1);
  } finally { fs.rmSync(paths.artifactDir, { recursive: true, force: true }); }
});

for (const [label, event] of [
  ["no assistant message", { messages: [] }],
  ["a terminating tool batch", { messages: [{ role: "assistant", content: [{ type: "toolCall", id: "terminate", name: "test", arguments: {} }], stopReason: "toolUse" }] }],
] as const) {
  test(`a worker ending with ${label} is recoverable after settlement`, async () => {
    const harness = createHarness();
    const paths = createWorkerArtifacts();
    try {
      writeWorkerRequest(paths, { id: "unfinished", task: "Work", tools: ["read"], resultPath: paths.resultPath, statusPath: paths.statusPath });
      await runCommand(harness, "worker-run", paths.requestPath);
      await emit(harness, "agent_end", event);
      assert.equal(readWorkerStatus(paths.statusPath)?.state, "running");
      await emit(harness, "agent_settled", {});
      assert.equal(readWorkerStatus(paths.statusPath)?.state, "supervised");
      assert.equal(fs.existsSync(paths.resultPath), false);
      await runCommand(harness, "worker-submit", "Recovered manually");
      await emit(harness, "agent_end", assistantEvent("everything was ok"));
      assert.equal(parseWorkerResult(fs.readFileSync(paths.resultPath, "utf8"), paths.resultPath, "unfinished").result, "Recovered manually");
    } finally { fs.rmSync(paths.artifactDir, { recursive: true, force: true }); }
  });
}

test("model setup errors produce a matching failure instead of stranding the parent", async () => {
  const harness = createHarness();
  const paths = createWorkerArtifacts();
  try {
    harness.modelFailure = new Error("Model initialization failed");
    writeWorkerRequest(paths, { id: "model-error", task: "Work", tools: ["read"], resultPath: paths.resultPath, statusPath: paths.statusPath });
    await runCommand(harness, "worker-run", paths.requestPath);
    const result = parseWorkerResult(fs.readFileSync(paths.resultPath, "utf8"), paths.resultPath, "model-error");
    assert.equal(result.isError, true);
    assert.match(result.result, /Model initialization failed/);
    assert.equal(readWorkerStatus(paths.statusPath)?.state, "closed");
    assert.deepEqual(harness.sentMessages, []);
  } finally { fs.rmSync(paths.artifactDir, { recursive: true, force: true }); }
});

test("finishing during asynchronous model selection cannot restart a completed request", async () => {
  const harness = createHarness();
  const paths = createWorkerArtifacts();
  let releaseModel!: () => void;
  harness.modelReady = new Promise<void>((resolve) => { releaseModel = resolve; });
  try {
    writeWorkerRequest(paths, { id: "model-pending", task: "Work", tools: ["read"], resultPath: paths.resultPath, statusPath: paths.statusPath });
    const startup = runCommand(harness, "worker-run", paths.requestPath);
    await Promise.resolve();
    await runCommand(harness, "finish-worker-now", "Recovered during startup");
    releaseModel();
    await startup;
    const result = parseWorkerResult(fs.readFileSync(paths.resultPath, "utf8"), paths.resultPath, "model-pending");
    assert.equal(result.result, "Recovered during startup");
    assert.deepEqual(harness.sentMessages, []);
    assert.equal(readWorkerStatus(paths.statusPath)?.state, "closed");
    assert.deepEqual(harness.recoveryPolicies, [true], "finishing main work does not disable later provider recovery");
  } finally { releaseModel(); fs.rmSync(paths.artifactDir, { recursive: true, force: true }); }
});

test("an unfinished retrospective preserves the result when the run settles", async () => {
  const harness = createHarness();
  const paths = createWorkerArtifacts();
  try {
    writeWorkerRequest(paths, { id: "empty-retrospective", task: "Work", tools: ["read"], resultPath: paths.resultPath, statusPath: paths.statusPath });
    await runCommand(harness, "worker-run", paths.requestPath);
    await emit(harness, "agent_end", assistantEvent("Saved main result"));
    await emit(harness, "agent_end", { messages: [] });
    assert.equal(fs.existsSync(paths.resultPath), false);
    await emit(harness, "agent_settled", {});
    const result = parseWorkerResult(fs.readFileSync(paths.resultPath, "utf8"), paths.resultPath, "empty-retrospective");
    assert.equal(result.result, "Saved main result");
    assert.equal(result.isError, false);
    assert.match(result.retrospective ?? "", /retrospective unavailable/);
    assert.equal(harness.shutdowns, 1);
  } finally { fs.rmSync(paths.artifactDir, { recursive: true, force: true }); }
});

test("exhausted overflow recovery enters supervision only at settlement", async () => {
  const harness = createHarness();
  const paths = createWorkerArtifacts();
  try {
    writeWorkerRequest(paths, { id: "overflow-exhausted", task: "Work", tools: ["read"], resultPath: paths.resultPath, statusPath: paths.statusPath });
    await runCommand(harness, "worker-run", paths.requestPath);
    await emit(harness, "agent_end", assistantErrorEvent("input exceeds the context window"));
    assert.equal(fs.existsSync(paths.resultPath), false);
    await emit(harness, "agent_settled", {});
    assert.equal(readWorkerStatus(paths.statusPath)?.state, "supervised");
    assert.match(readWorkerStatus(paths.statusPath)?.supervisionReason ?? "", /context window/);
    assert.equal(fs.existsSync(paths.resultPath), false);
    assert.equal(harness.shutdowns, 0);
  } finally { fs.rmSync(paths.artifactDir, { recursive: true, force: true }); }
});

for (const outcome of ["resumed", "failed", "human", "unmatched", "errored-result", "aborted"] as const) {
  test(`compaction handoffs preserve only matching intentional termination: ${outcome}`, async () => {
    const harness = createHarness();
    const paths = createWorkerArtifacts();
    const handoff = (event: SelfCompactHandoff) => harness.events.emit(SELF_COMPACT_HANDOFF_EVENT, event);
    try {
      writeWorkerRequest(paths, { id: "handoff", task: "Work", tools: ["read"], resultPath: paths.resultPath, statusPath: paths.statusPath });
      await runCommand(harness, "worker-run", paths.requestPath);
      handoff({ state: "pending", toolCallId: "compact" });
      const id = outcome === "unmatched" ? "another-tool" : "compact";
      await emit(harness, "agent_end", outcome === "aborted" ? assistantAbortEvent() : {
        messages: [
          { role: "assistant", content: [{ type: "toolCall", id, name: "self_compact", arguments: {} }], stopReason: "toolUse" },
          { role: "toolResult", toolCallId: id, isError: outcome === "errored-result", content: [] },
        ],
      });
      await emit(harness, "agent_settled", {});
      if (["unmatched", "errored-result", "aborted"].includes(outcome)) {
        assert.equal(readWorkerStatus(paths.statusPath)?.state, "supervised");
        handoff({ state: "resumed", toolCallId: "compact" });
        assert.equal(readWorkerStatus(paths.statusPath)?.state, "supervised");
        return;
      }
      assert.equal(readWorkerStatus(paths.statusPath)?.state, "running");
      // Unrelated callbacks cannot resolve or fail this request's handoff.
      handoff({ state: "failed", toolCallId: "stale", reason: "Stale failure" });
      assert.equal(readWorkerStatus(paths.statusPath)?.state, "running");
      if (outcome === "failed") {
        handoff({ state: "failed", toolCallId: "compact", reason: "Compaction cancelled" });
        assert.equal(readWorkerStatus(paths.statusPath)?.state, "supervised");
        assert.match(readWorkerStatus(paths.statusPath)?.supervisionReason ?? "", /Compaction cancelled/);
        handoff({ state: "resumed", toolCallId: "compact" });
        assert.equal(readWorkerStatus(paths.statusPath)?.state, "supervised");
        return;
      }
      if (outcome === "human") await emit(harness, "input", { source: "interactive", text: "Wait for me" });
      handoff({ state: "resumed", toolCallId: "compact" });
      await emit(harness, "agent_end", assistantEvent("Final result"));
      if (outcome === "human") {
        assert.equal(readWorkerStatus(paths.statusPath)?.state, "supervised");
        assert.equal(harness.recoveryPolicies.at(-1), true, "compaction preserves supervised main-task recovery");
        harness.events.emit("pi-claude-agent:recovery-status", { sessionId: "worker-frame-test", retryAt: Date.now() + 60_000 });
        assert.notEqual(readWorkerStatus(paths.statusPath)?.retryAt, undefined);
        assert.match(harness.statuses.get("worker-frame") ?? "", /supervised.*quota-wait/);
        harness.events.emit("pi-claude-agent:recovery-status", { sessionId: "worker-frame-test" });
        assert.equal(fs.existsSync(paths.resultPath), false);
        await runCommand(harness, "worker-submit");
      }
      await emit(harness, "agent_end", assistantEvent("everything was ok"));
      const result = parseWorkerResult(fs.readFileSync(paths.resultPath, "utf8"), paths.resultPath, "handoff");
      assert.equal(result.result, "Final result");
      assert.equal(harness.shutdowns, 1);
    } finally { fs.rmSync(paths.artifactDir, { recursive: true, force: true }); }
  });
}

test("worker shutdown detaches handoff listeners and ignores late callbacks", async () => {
  const harness = createHarness();
  const paths = createWorkerArtifacts();
  try {
    writeWorkerRequest(paths, { id: "shutdown", task: "Work", tools: ["read"], resultPath: paths.resultPath, statusPath: paths.statusPath });
    await runCommand(harness, "worker-run", paths.requestPath);
    harness.events.emit(SELF_COMPACT_HANDOFF_EVENT, { state: "pending", toolCallId: "compact" } satisfies SelfCompactHandoff);
    await emit(harness, "session_shutdown", {});
    harness.events.emit(SELF_COMPACT_HANDOFF_EVENT, { state: "failed", toolCallId: "compact", reason: "Late failure" } satisfies SelfCompactHandoff);
    assert.equal(readWorkerStatus(paths.statusPath)?.state, "running");
    assert.equal(harness.notifications.length, 0);
  } finally { fs.rmSync(paths.artifactDir, { recursive: true, force: true }); }
});

test("provider recovery status preserves automatic work, follows only this session, and clears without a new prompt", async () => {
  const harness = createHarness();
  const paths = createWorkerArtifacts();
  const retryAt = Date.now() + 60_000;
  const report = (data: unknown) => harness.events.emit("pi-claude-agent:recovery-status", data);
  try {
    writeWorkerRequest(paths, { id: "quota-wait", task: "Work", tools: ["read"], resultPath: paths.resultPath, statusPath: paths.statusPath });
    await runCommand(harness, "worker-run", paths.requestPath);
    assert.deepEqual(harness.recoveryPolicies, [true]);
    for (const data of [null, {}, { sessionId: "another", retryAt }, { sessionId: "worker-frame-test", retryAt: NaN }, { sessionId: "worker-frame-test", retryAt: -1 }]) report(data);
    assert.equal(readWorkerStatus(paths.statusPath)?.retryAt, undefined);
    report({ sessionId: "worker-frame-test", retryAt });
    assert.equal(readWorkerStatus(paths.statusPath)?.state, "running");
    assert.equal(readWorkerStatus(paths.statusPath)?.retryAt, retryAt);
    assert.equal(harness.statuses.get("worker-frame"), "worker:quota-wait");
    assert.ok(harness.widgets.get("worker-frame")?.join("\n").includes(formatWorkerRetryTime(retryAt)));
    await emit(harness, "turn_end", {});
    await emit(harness, "input", { source: "extension", text: "internal prompt" });
    assert.equal(readWorkerStatus(paths.statusPath)?.retryAt, retryAt);
    report({ sessionId: "another" });
    assert.equal(readWorkerStatus(paths.statusPath)?.retryAt, retryAt);
    report({ sessionId: "worker-frame-test", retryAt: retryAt + 20_000 });
    assert.equal(readWorkerStatus(paths.statusPath)?.retryAt, retryAt + 20_000);
    report({ sessionId: "worker-frame-test" });
    assert.equal(readWorkerStatus(paths.statusPath)?.retryAt, undefined);
    assert.equal(harness.statuses.get("worker-frame"), "worker:auto");
    assert.equal(harness.widgets.get("worker-frame"), undefined);
    assert.equal(harness.sentMessages.length, 1, "recovery status never injects a continuation message");
    assert.equal(fs.existsSync(paths.resultPath), false);
    await emit(harness, "agent_end", assistantEvent("Recovered main result"));
    assert.equal(harness.sentRecoveryPolicies.at(-1), false, "retrospective inference must fail fast");
    report({ sessionId: "worker-frame-test", retryAt });
    assert.equal(readWorkerStatus(paths.statusPath)?.retryAt, undefined);
    await emit(harness, "agent_end", assistantErrorEvent("Claude five-hour subscription limit reached"));
    await emit(harness, "agent_settled", {});
    const result = parseWorkerResult(fs.readFileSync(paths.resultPath, "utf8"), paths.resultPath, "quota-wait");
    assert.equal(result.result, "Recovered main result");
    assert.equal(result.isError, false);
    assert.match(result.retrospective ?? "", /retrospective unavailable/);
  } finally { fs.rmSync(paths.artifactDir, { recursive: true, force: true }); }
});

for (const source of ["interactive", "rpc"] as const) {
  test(`${source} supervision preserves an active quota wait and later main-request recovery`, async () => {
    const harness = createHarness();
    const paths = createWorkerArtifacts();
    const retryAt = Date.now() + 60_000;
    const report = (deadline?: number) => harness.events.emit("pi-claude-agent:recovery-status", { sessionId: "worker-frame-test", retryAt: deadline });
    try {
      writeWorkerRequest(paths, { id: "supervised-quota", task: "Work", tools: ["read"], resultPath: paths.resultPath, statusPath: paths.statusPath });
      await runCommand(harness, "worker-run", paths.requestPath);
      report(retryAt);
      await emit(harness, "input", { source, text: "Keep stricter timeouts" });
      assert.equal(harness.recoveryPolicies.at(-1), true);
      assert.equal(readWorkerStatus(paths.statusPath)?.state, "supervised");
      assert.equal(readWorkerStatus(paths.statusPath)?.retryAt, retryAt, "human input does not cancel provider waiting");
      assert.match(harness.statuses.get("worker-frame") ?? "", /supervised.*quota-wait/);
      assert.ok(harness.widgets.get("worker-frame")?.join("\n").includes(formatWorkerRetryTime(retryAt)));

      // Escape clears only this provider request. Plain human input afterwards
      // must remain supervised while retaining quota recovery (the incident).
      report();
      await emit(harness, "agent_end", assistantAbortEvent());
      await emit(harness, "agent_settled", {});
      assert.equal(readWorkerStatus(paths.statusPath)?.retryAt, undefined);
      assert.equal(harness.recoveryPolicies.at(-1), true);
      await emit(harness, "input", { source, text: "Go" });
      report(retryAt + 20_000);
      assert.equal(readWorkerStatus(paths.statusPath)?.state, "supervised");
      assert.equal(readWorkerStatus(paths.statusPath)?.retryAt, retryAt + 20_000);
      assert.equal(harness.recoveryPolicies.at(-1), true);
      report();
      await emit(harness, "agent_end", assistantEvent("Recovered supervised reply"));
      assert.equal(fs.existsSync(paths.resultPath), false, "provider recovery does not restore automatic completion");
      assert.match(harness.widgets.get("worker-frame")?.join("\n") ?? "", /ready to submit/);
      assert.equal(harness.sentMessages.length, 1, "quota recovery does not inject guidance");
      await runCommand(harness, "worker-submit");
      assert.equal(harness.sentRecoveryPolicies.at(-1), false, "only the retrospective disables waiting");
      await emit(harness, "agent_end", assistantErrorEvent("Claude five-hour subscription limit reached"));
      await emit(harness, "agent_settled", {});
      const result = parseWorkerResult(fs.readFileSync(paths.resultPath, "utf8"), paths.resultPath, "supervised-quota");
      assert.equal(result.result, "Recovered supervised reply");
      assert.match(result.retrospective ?? "", /retrospective unavailable/);
    } finally { fs.rmSync(paths.artifactDir, { recursive: true, force: true }); }
  });
}

test("worker-continue changes capture without interrupting a supervised quota wait", async () => {
  const harness = createHarness();
  const paths = createWorkerArtifacts();
  const retryAt = Date.now() + 60_000;
  try {
    writeWorkerRequest(paths, { id: "continue-quota", task: "Work", tools: ["read"], resultPath: paths.resultPath, statusPath: paths.statusPath });
    await runCommand(harness, "worker-run", paths.requestPath);
    await emit(harness, "input", { source: "rpc", text: "Discuss first" });
    harness.events.emit("pi-claude-agent:recovery-status", { sessionId: "worker-frame-test", retryAt });
    await runCommand(harness, "worker-continue", "Finish automatically");
    assert.equal(readWorkerStatus(paths.statusPath)?.state, "running");
    assert.equal(readWorkerStatus(paths.statusPath)?.retryAt, retryAt);
    assert.equal(harness.statuses.get("worker-frame"), "worker:quota-wait");
    assert.equal(harness.sentRecoveryPolicies.at(-1), true);
    assert.deepEqual(harness.recoveryPolicies, [true], "capture changes publish no quota policy changes");
  } finally { fs.rmSync(paths.artifactDir, { recursive: true, force: true }); }
});

for (const action of ["submit", "finish", "shutdown"] as const) {
  test(`${action} ends quota reporting without disabling later main-request recovery`, async () => {
    const harness = createHarness();
    const paths = createWorkerArtifacts();
    const report = (retryAt?: number) => harness.events.emit("pi-claude-agent:recovery-status", { sessionId: "worker-frame-test", retryAt });
    const context = harness.context as { isIdle(): boolean; abort(): Promise<void> };
    let aborts = 0;
    try {
      writeWorkerRequest(paths, { id: "quota-end", task: "Work", tools: ["read"], resultPath: paths.resultPath, statusPath: paths.statusPath });
      await runCommand(harness, "worker-run", paths.requestPath);
      report(Date.now() + 60_000);
      context.isIdle = () => false;
      context.abort = async () => {
        aborts++;
        assert.equal(harness.recoveryPolicies.at(-1), true, "explicit abort, not supervision, cancels the request");
        report();
        await emit(harness, "agent_end", assistantAbortEvent());
        await emit(harness, "agent_settled", {});
      };
      if (action === "shutdown") await emit(harness, "session_shutdown", {});
      else await runCommand(harness, action === "submit" ? "worker-submit" : "finish-worker-now", "Human result");
      assert.equal(aborts, action === "shutdown" ? 0 : 1);
      assert.equal(harness.recoveryPolicies.at(-1), action !== "submit");
      assert.equal(readWorkerStatus(paths.statusPath)?.retryAt, undefined);
      const after = fs.readFileSync(paths.statusPath, "utf8");
      report(Date.now() + 60_000);
      assert.equal(fs.readFileSync(paths.statusPath, "utf8"), after, "retired or retrospective requests ignore late status");
    } finally { fs.rmSync(paths.artifactDir, { recursive: true, force: true }); }
  });
}

test("submission cancels quota waiting that begins after it started and waits for settlement", async () => {
  const harness = createHarness();
  const paths = createWorkerArtifacts();
  const context = harness.context as { isIdle(): boolean; abort(): Promise<void> };
  let releaseIdle: (() => void) | undefined;
  let releaseAbort: (() => void) | undefined;
  let aborts = 0;
  try {
    writeWorkerRequest(paths, { id: "submit-before-quota", task: "Work", tools: ["read"], resultPath: paths.resultPath, statusPath: paths.statusPath });
    await runCommand(harness, "worker-run", paths.requestPath);
    context.isIdle = () => false;
    harness.waitForIdle = () => new Promise<void>((resolve) => { releaseIdle = resolve; });
    context.abort = async () => {
      aborts++;
      assert.equal(harness.recoveryPolicies.at(-1), true);
      await new Promise<void>((resolve) => { releaseAbort = resolve; });
      harness.events.emit("pi-claude-agent:recovery-status", { sessionId: "worker-frame-test" });
      await emit(harness, "agent_end", assistantAbortEvent());
      await emit(harness, "agent_settled", {});
      context.isIdle = () => true;
      releaseIdle?.();
    };
    const submission = runCommand(harness, "worker-submit", "Submitted while busy");
    const retryAt = Date.now() + 60_000;
    harness.events.emit("pi-claude-agent:recovery-status", { sessionId: "another-session", retryAt });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(aborts, 0, "unrelated quota reports cannot cancel this request");
    harness.events.emit("pi-claude-agent:recovery-status", { sessionId: "worker-frame-test", retryAt });
    harness.events.emit("pi-claude-agent:recovery-status", { sessionId: "worker-frame-test", retryAt });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(aborts, 1, "a pending submission cancels a later quota wait exactly once");
    assert.equal(fs.existsSync(paths.resultMarkdownPath), false, "abort must settle before saving the submitted result");
    releaseAbort?.();
    await submission;
    assert.equal(fs.readFileSync(paths.resultMarkdownPath, "utf8"), "Submitted while busy");
    assert.equal(harness.sentRecoveryPolicies.at(-1), false, "retrospective cannot start quota waiting");
    await emit(harness, "agent_end", assistantErrorEvent("fixture retrospective quota unavailable"));
    await emit(harness, "agent_settled", {});
    const result = parseWorkerResult(fs.readFileSync(paths.resultPath, "utf8"), paths.resultPath, "submit-before-quota");
    assert.equal(result.result, "Submitted while busy");
    assert.match(result.retrospective ?? "", /retrospective unavailable/);
    assert.equal(result.isError, false);
  } finally { fs.rmSync(paths.artifactDir, { recursive: true, force: true }); }
});

for (const waitingBeforeSubmit of [true, false]) {
  test(`empty submission does not cancel quota waiting (${waitingBeforeSubmit ? "already waiting" : "wait begins later"})`, async () => {
    const harness = createHarness();
    const paths = createWorkerArtifacts();
    const context = harness.context as { isIdle(): boolean; abort(): Promise<void> };
    let aborts = 0;
    try {
      writeWorkerRequest(paths, { id: "empty-submit-quota", task: "Work", tools: ["read"], resultPath: paths.resultPath, statusPath: paths.statusPath });
      await runCommand(harness, "worker-run", paths.requestPath);
      context.isIdle = () => false;
      harness.waitForIdle = () => new Promise<void>(() => undefined);
      context.abort = async () => { aborts++; };
      const report = () => harness.events.emit("pi-claude-agent:recovery-status", { sessionId: "worker-frame-test", retryAt: Date.now() + 60_000 });
      if (waitingBeforeSubmit) report();
      let completed = false;
      const submission = runCommand(harness, "worker-submit").then(() => { completed = true; });
      if (!waitingBeforeSubmit) report();
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(aborts, 0);
      assert.equal(completed, true, "no-result submission reports promptly instead of waiting for quota reset");
      await submission;
      assert.match(harness.notifications.at(-1) ?? "", /No assistant reply is ready/);
      assert.equal(readWorkerStatus(paths.statusPath)?.state, "supervised");
      assert.ok(readWorkerStatus(paths.statusPath)?.retryAt);
      assert.deepEqual(harness.recoveryPolicies, [true]);
      assert.equal(fs.existsSync(paths.resultMarkdownPath), false);
      await runCommand(harness, "worker-continue", "Continue normally");
      assert.doesNotMatch(harness.notifications.at(-1) ?? "", /submission is already waiting/);
    } finally { fs.rmSync(paths.artifactDir, { recursive: true, force: true }); }
  });
}

for (const abortFailure of ["sync", "async"] as const) {
  test(`submission releases ownership when quota cancellation fails (${abortFailure})`, async () => {
    const harness = createHarness();
    const paths = createWorkerArtifacts();
    const context = harness.context as { isIdle(): boolean; abort(): Promise<void> };
    let releaseIdle: (() => void) | undefined;
    let aborts = 0;
    try {
      writeWorkerRequest(paths, { id: "submit-abort-failure", task: "Work", tools: ["read"], resultPath: paths.resultPath, statusPath: paths.statusPath });
      await runCommand(harness, "worker-run", paths.requestPath);
      context.isIdle = () => false;
      harness.waitForIdle = () => new Promise<void>((resolve) => { releaseIdle = resolve; });
      context.abort = () => {
        aborts++;
        if (abortFailure === "sync") throw new Error("fixture cancellation failed");
        return Promise.reject(new Error("fixture cancellation failed"));
      };
      const submission = runCommand(harness, "worker-submit", "Manual result");
      const rejected = assert.rejects(submission, /fixture cancellation failed/);
      harness.events.emit("pi-claude-agent:recovery-status", { sessionId: "worker-frame-test", retryAt: Date.now() + 60_000 });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(aborts, 1);
      await rejected;
      harness.events.emit("pi-claude-agent:recovery-status", { sessionId: "worker-frame-test", retryAt: Date.now() + 60_000 });
      assert.equal(aborts, 1, "failed submission removes its quota listener");
      assert.equal(fs.existsSync(paths.resultMarkdownPath), false);
      releaseIdle?.();
      await runCommand(harness, "worker-continue", "Continue after cancellation failure");
      assert.doesNotMatch(harness.notifications.at(-1) ?? "", /submission is already waiting/);
      assert.deepEqual(harness.recoveryPolicies, [true]);
    } finally { fs.rmSync(paths.artifactDir, { recursive: true, force: true }); }
  });
}

test("retired submission cannot cancel a later quota request", async () => {
  const harness = createHarness();
  const paths = createWorkerArtifacts();
  const context = harness.context as { isIdle(): boolean; abort(): Promise<void> };
  let releaseIdle: (() => void) | undefined;
  let aborts = 0;
  try {
    writeWorkerRequest(paths, { id: "retired-submit", task: "Work", tools: ["read"], resultPath: paths.resultPath, statusPath: paths.statusPath });
    await runCommand(harness, "worker-run", paths.requestPath);
    context.isIdle = () => false;
    harness.waitForIdle = () => new Promise<void>((resolve) => { releaseIdle = resolve; });
    context.abort = async () => { aborts++; };
    const submission = runCommand(harness, "worker-submit", "Manual result");
    await emit(harness, "session_shutdown", {});
    harness.events.emit("pi-claude-agent:recovery-status", { sessionId: "worker-frame-test", retryAt: Date.now() + 60_000 });
    releaseIdle?.();
    await submission;
    assert.equal(aborts, 0);
    assert.equal(fs.existsSync(paths.resultMarkdownPath), false);
    assert.match(harness.notifications.at(-1) ?? "", /no longer active/);
  } finally { fs.rmSync(paths.artifactDir, { recursive: true, force: true }); }
});

test("result parsing rejects mismatched late requests and malformed artifacts", () => {
  const valid = { id: "late", result: "Stale", timestamp: new Date().toISOString() };
  assert.throws(() => parseWorkerResult(JSON.stringify(valid), "/tmp/result.json", "current"), /id mismatch/);
  assert.throws(() => parseWorkerResult("{", "/tmp/result.json", "current"), /Invalid worker result JSON/);
  assert.throws(() => parseWorkerResult('{"id":"current"}', "/tmp/result.json", "current"), /Invalid worker result shape/);
});
