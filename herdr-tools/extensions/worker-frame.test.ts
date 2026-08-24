import assert from "node:assert/strict";
import * as fs from "node:fs";
import test from "node:test";
import workerFrameExtension, {
  createWorkerArtifacts,
  parseWorkerResult,
  readWorkerStatus,
  writeWorkerRequest,
} from "./worker-frame.ts";

type WorkerFramePi = Parameters<typeof workerFrameExtension>[0];
type EventHandler = (event: unknown, ctx: unknown) => unknown;
type CommandHandler = (args: string, ctx: unknown) => unknown;

interface WorkerFrameHarness {
  activeTools: string[];
  commands: Map<string, CommandHandler>;
  context: unknown;
  handlers: Map<string, EventHandler[]>;
  notifications: string[];
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
    commands,
    context: undefined,
    handlers,
    notifications,
    sentDeliveryModes: [],
    sentMessages,
    shutdowns: 0,
    statuses,
    waitForIdle: async () => undefined,
    widgets,
  };

  const pi = {
    getActiveTools: () => [...harness.activeTools],
    on: (name: string, handler: EventHandler) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerCommand: (name: string, command: { handler: CommandHandler }) => {
      commands.set(name, command.handler);
    },
    sendUserMessage: (message: string, options?: { deliverAs?: "steer" | "followUp" }) => {
      sentMessages.push(message);
      harness.sentDeliveryModes.push(options?.deliverAs);
    },
    setActiveTools: (tools: string[]) => {
      harness.activeTools = [...tools];
    },
  } as unknown as WorkerFramePi;

  harness.context = {
    abort: () => undefined,
    getContextUsage: () => ({ percent: 12.5 }),
    isIdle: () => true,
    sessionManager: {
      getBranch: () => [],
      getSessionFile: () => "/tmp/worker-frame-test-session.jsonl",
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

function assistantErrorEvent(errorMessage: string): unknown {
  return {
    messages: [{
      role: "assistant",
      content: [],
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

test("human input supervises result and retrospective capture until explicit submission", async () => {
  const harness = createHarness();
  const paths = createWorkerArtifacts();
  try {
    writeWorkerRequest(paths, {
      id: "supervised-worker",
      task: "Complete the delegated task",
      resultPath: paths.resultPath,
      statusPath: paths.statusPath,
      closeWhenDone: true,
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
    assert.equal(contextResult.messages.at(-1)?.customType, "pi-herdr:supervision");
    assert.match(contextResult.messages.at(-1)?.content ?? "", /Respond normally/);

    await emit(harness, "agent_end", assistantEvent("Discussion reply"));
    assert.equal(fs.existsSync(paths.resultPath), false);
    assert.match(harness.widgets.get("worker-frame")?.join("\n") ?? "", /ready to submit/);

    await runCommand(harness, "worker-submit");
    assert.equal(fs.readFileSync(paths.resultMarkdownPath, "utf8"), "Discussion reply");
    assert.equal(readWorkerStatus(paths.statusPath)?.state, "retrospective");
    assert.deepEqual(harness.activeTools, []);
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
      resultPath: paths.resultPath,
      statusPath: paths.statusPath,
      closeWhenDone: true,
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
      resultPath: paths.resultPath,
      statusPath: paths.statusPath,
      closeWhenDone: true,
    });

    await runCommand(harness, "worker-run", paths.requestPath);
    await emit(harness, "agent_end", assistantEvent("Saved main result"));
    await emit(harness, "input", { source: "interactive", text: "Explain that observation" });
    assert.equal(readWorkerStatus(paths.statusPath)?.state, "supervised");
    assert.deepEqual(harness.activeTools, ["read", "bash"]);
    await emit(harness, "agent_end", assistantEvent("Outdated retrospective reply"));

    await runCommand(harness, "worker-continue", "Include only the important observation");
    assert.equal(readWorkerStatus(paths.statusPath)?.state, "retrospective");
    assert.deepEqual(harness.activeTools, []);
    assert.equal(harness.sentMessages.at(-1), "Include only the important observation");
    assert.equal(harness.sentDeliveryModes.at(-1), "steer");
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

test("worker-continue clears supervised failure state before retrying automatically", async () => {
  const harness = createHarness();
  const paths = createWorkerArtifacts();
  try {
    writeWorkerRequest(paths, {
      id: "continued-failure-worker",
      task: "Recover with guidance",
      resultPath: paths.resultPath,
      statusPath: paths.statusPath,
      closeWhenDone: true,
    });

    await runCommand(harness, "worker-run", paths.requestPath);
    await emit(harness, "agent_end", assistantErrorEvent("Connection error."));
    await emit(harness, "agent_settled", {});
    assert.equal(readWorkerStatus(paths.statusPath)?.state, "supervised");
    assert.match(readWorkerStatus(paths.statusPath)?.supervisionReason ?? "", /Connection error/);

    await runCommand(harness, "worker-continue", "Retry using the existing evidence");
    const continuedStatus = readWorkerStatus(paths.statusPath);
    assert.equal(continuedStatus?.state, "running");
    assert.equal(continuedStatus?.supervisionReason, undefined);
    await emit(harness, "agent_end", assistantErrorEvent("Pre-guidance connection error."));
    await emit(harness, "agent_settled", {});
    assert.equal(readWorkerStatus(paths.statusPath)?.state, "running");
    assert.equal(fs.existsSync(paths.resultPath), false);
    await emit(harness, "message_start", userMessageStart("Retry using the existing evidence"));
    await emit(harness, "agent_end", assistantEvent("Recovered automatically"));
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
      resultPath: paths.resultPath,
      statusPath: paths.statusPath,
      closeWhenDone: false,
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
      resultPath: paths.resultPath,
      statusPath: paths.statusPath,
      closeWhenDone: false,
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
      resultPath: paths.resultPath,
      statusPath: paths.statusPath,
      closeWhenDone: false,
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
    assert.equal(harness.shutdowns, 0);
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
      resultPath: paths.resultPath,
      statusPath: paths.statusPath,
      closeWhenDone: true,
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

test("retryable retrospective failure preserves the main result after retries settle", async () => {
  const harness = createHarness();
  const paths = createWorkerArtifacts();
  try {
    writeWorkerRequest(paths, {
      id: "retrospective-retry-worker",
      task: "Complete before retrospective failure",
      resultPath: paths.resultPath,
      statusPath: paths.statusPath,
      closeWhenDone: true,
    });

    await runCommand(harness, "worker-run", paths.requestPath);
    await emit(harness, "agent_end", assistantEvent("Main result"));
    await emit(harness, "agent_end", assistantErrorEvent("Connection error."));
    assert.equal(fs.existsSync(paths.resultPath), false);
    await emit(harness, "agent_settled", {});

    const result = parseWorkerResult(
      fs.readFileSync(paths.resultPath, "utf8"),
      paths.resultPath,
      "retrospective-retry-worker",
    );
    assert.equal(result.result, "Main result");
    assert.equal(result.isError, false);
    assert.equal(result.retrospective, "retrospective unavailable: automatic worker run ended without a result. Connection error.");
    assert.equal(harness.shutdowns, 1);
  } finally {
    fs.rmSync(paths.artifactDir, { recursive: true, force: true });
  }
});

test("cancelled result enters supervision after the worker run settles", async () => {
  const harness = createHarness();
  const paths = createWorkerArtifacts();
  try {
    writeWorkerRequest(paths, {
      id: "cancelled-worker",
      task: "Wait for cancellation",
      resultPath: paths.resultPath,
      statusPath: paths.statusPath,
      closeWhenDone: true,
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
      resultPath: paths.resultPath,
      statusPath: paths.statusPath,
      closeWhenDone: true,
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

test("non-retryable result failure completes after automatic recovery settles", async () => {
  const harness = createHarness();
  const paths = createWorkerArtifacts();
  try {
    writeWorkerRequest(paths, {
      id: "quota-worker",
      task: "Fail without retry supervision",
      resultPath: paths.resultPath,
      statusPath: paths.statusPath,
      closeWhenDone: true,
    });

    await runCommand(harness, "worker-run", paths.requestPath);
    await emit(harness, "agent_end", assistantErrorEvent("429 quota exceeded"));
    assert.equal(fs.existsSync(paths.resultPath), false);
    await emit(harness, "agent_settled", {});

    const result = parseWorkerResult(fs.readFileSync(paths.resultPath, "utf8"), paths.resultPath, "quota-worker");
    assert.equal(result.result, "429 quota exceeded");
    assert.equal(result.isError, true);
    assert.equal(harness.shutdowns, 1);
  } finally {
    fs.rmSync(paths.artifactDir, { recursive: true, force: true });
  }
});

test("context overflow remains pending while Pi runs automatic compaction recovery", async () => {
  const harness = createHarness();
  const paths = createWorkerArtifacts();
  try {
    writeWorkerRequest(paths, {
      id: "overflow-worker",
      task: "Recover after context overflow",
      resultPath: paths.resultPath,
      statusPath: paths.statusPath,
      closeWhenDone: true,
    });

    await runCommand(harness, "worker-run", paths.requestPath);
    await emit(harness, "agent_end", assistantErrorEvent("500 server error: input exceeds the context window"));
    assert.equal(fs.existsSync(paths.resultPath), false);

    await emit(harness, "agent_end", assistantEvent("Recovered after compaction"));
    await emit(harness, "agent_end", assistantEvent("everything was ok"));

    const result = parseWorkerResult(fs.readFileSync(paths.resultPath, "utf8"), paths.resultPath, "overflow-worker");
    assert.equal(result.result, "Recovered after compaction");
    assert.equal(result.isError, false);
    assert.equal(result.retrospective, "everything was ok");
    assert.equal(harness.shutdowns, 1);
  } finally {
    fs.rmSync(paths.artifactDir, { recursive: true, force: true });
  }
});
