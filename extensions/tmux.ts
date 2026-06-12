/**
 * Tmux Extension (script-backed)
 *
 * Delegates tmux operations to ../bin/pi-tmux.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, SessionEntry, SessionHeader } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";

const TMUX_SCRIPT = path.resolve(__dirname, "../bin/pi-tmux");
const PI_FORK = process.env.PI_FORK === "true";
const FORK_BLOCK_MESSAGE = "You are the fork, this tool is blocked. Do what you were told.";

/** Per-pane state for new-only capture */
const captureState = new Map<string, number>(); // target:paneId -> totalLines at last capture

const DEFAULT_MAX_NEW = 500;
const MINI_LIVE_LINE_LIMIT = 15;

function clearCaptureStateForTarget(target: string): void {
  captureState.delete(target);
  for (const key of [...captureState.keys()]) {
    if (key.startsWith(`${target}:`)) {
      captureState.delete(key);
    }
  }
}

function isTmuxAvailable(): boolean {
  return !!process.env.TMUX;
}

async function runTmux(
  pi: ExtensionAPI,
  args: string[],
  signal?: AbortSignal,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return pi.exec("bash", [TMUX_SCRIPT, ...args], { signal });
}

function outputText(stdout: string, stderr: string): string {
  const text = stdout.trim() || stderr.trim();
  return text.length > 0 ? text : "(no output)";
}

const tmuxBashParams = Type.Object({
  name: Type.String({
    description: "Lock name for the spawned tmux pane",
  }),
  command: Type.String({
    description: "Command to execute in the tmux pane",
  }),
});
export type TmuxBashInput = Static<typeof tmuxBashParams>;

const tmuxCaptureParams = Type.Object({
  name: Type.String({
    description: "Lock name or pane id (e.g., worker or %12)",
  }),
  lines: Type.Optional(
    Type.Number({ description: "Number of lines to capture (default: 500)" }),
  ),
  watch: Type.Optional(
    Type.String({
      description: "Regex pattern — sets up a semaphore_wait lock that releases when the pattern appears in new pane output.",
    }),
  ),
});
export type TmuxCaptureInput = Static<typeof tmuxCaptureParams>;

const tmuxSendParams = Type.Object({
  name: Type.String({ description: "Lock name or pane id" }),
  text: Type.String({
    description:
      "Text or keys to send (e.g., 'ls -la', 'Enter', 'C-c' for Ctrl+C)",
  }),
  enter: Type.Optional(
    Type.Boolean({
      description: "Whether to press Enter after sending text (default: true)",
    }),
  ),
});
export type TmuxSendInput = Static<typeof tmuxSendParams>;

const tmuxKillParams = Type.Object({
  name: Type.String({ description: "Lock name or pane id" }),
});
export type TmuxKillInput = Static<typeof tmuxKillParams>;

const tmuxCodingAgentParams = Type.Object({
  name: Type.String({
    description: "Lock name for the coding agent",
  }),
  folder: Type.String({
    description: "Working directory for the pi instance (e.g., '../hppr')",
  }),
  piArgs: Type.Optional(
    Type.String({
      description:
        "Additional pi CLI arguments. Omit this to use pi's saved last active model; pass --provider/--model only to override.",
    }),
  ),
  contextAlertPercent: Type.Optional(
    Type.Number({
      description:
        "Context usage percentage (1-100) at which to release a <name>:context lock. " +
        "Use semaphore_wait with the context lock name to be notified when the agent's context is filling up.",
    }),
  ),
});
export type TmuxCodingAgentInput = Static<typeof tmuxCodingAgentParams>;

const minitaskParams = Type.Object({
  task: Type.String({
    minLength: 1,
    description: "One question or small task to answer with a single isolated pi RPC run.",
  }),
  simple: Type.Optional(
    Type.Boolean({
      description:
        "Use for quick rote tasks, like verifying whether a pattern is used in a file. Runs pi with --provider openai-codex --model gpt-5.3-codex-spark, retrying with --thinking off if that exits nonzero, then falling back to deepseek/deepseek-v4-pro if Spark still fails.",
    }),
  ),
});
export type MinitaskInput = Static<typeof minitaskParams>;

const tempforkParams = Type.Object({
  task: Type.String({
    minLength: 1,
    description: "One question or small task to answer in a temporary fork of the current session using pi -p.",
  }),
  folder: Type.Optional(
    Type.String({ description: "Working directory for the temporary fork. Defaults to the current working directory." }),
  ),
  simple: Type.Optional(
    Type.Boolean({
      description:
        "Use the same cheap/fallback model sequence as minitask instead of the current session model.",
    }),
  ),
  keepSession: Type.Optional(
    Type.Boolean({ description: "Keep the temporary snapshot and forked session directory instead of deleting it." }),
  ),
});
export type TempforkInput = Static<typeof tempforkParams>;

type MinitaskResult = {
  task: string;
  answer: string;
  exitCode: number;
};

type PiPrintTaskRun = MinitaskResult & {
  args: string[];
};

type TempforkFiles = {
  root: string;
  snapshotFile: string;
  promptFile: string;
  sessionDir: string;
};

function formatMinitaskResult(result: MinitaskResult): string {
  const exitLabel = result.exitCode === 0 ? "" : ` (exit code ${result.exitCode})`;
  return [
    "## Task",
    result.task,
    "",
    `## Answer${exitLabel}`,
    result.answer || "(no output)",
  ].join("\n");
}

function buildPiPrintAttempts(simple: boolean, baseArgs: string[]): string[][] {
  if (!simple) return [baseArgs];
  return [
    ["--provider", "openai-codex", "--model", "gpt-5.3-codex-spark", ...baseArgs],
    ["--provider", "openai-codex", "--model", "gpt-5.3-codex-spark", "--thinking", "off", ...baseArgs],
    ["--provider", "deepseek", "--model", "deepseek-v4-pro", ...baseArgs],
  ];
}

async function runPiPrintTask(
  pi: ExtensionAPI,
  task: string,
  cwd: string,
  baseArgs: string[],
  simple: boolean,
  signal?: AbortSignal,
  forkEnv = false,
): Promise<PiPrintTaskRun> {
  let answer = "(no output)";
  let exitCode = 0;
  let usedArgs = baseArgs;

  try {
    for (const args of buildPiPrintAttempts(simple, baseArgs)) {
      usedArgs = args;
      const command = forkEnv ? "env" : "pi";
      const commandArgs = forkEnv ? ["PI_FORK=true", "pi", ...args] : args;
      const result = await pi.exec(command, commandArgs, { signal, cwd });
      exitCode = result.code;
      answer = outputText(result.stdout, result.stderr);
      if (!simple || result.code === 0) break;
    }
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw err;
    }

    answer = `Error: ${err instanceof Error ? err.message : String(err)}`;
    exitCode = 1;
  }

  return { task, answer, exitCode, args: usedArgs };
}

type RpcRecord = Record<string, unknown> & {
  id?: string;
  type?: string;
  command?: string;
  success?: boolean;
  error?: string;
};

type PendingRpcRequest = {
  resolve: (response: RpcRecord) => void;
  reject: (error: Error) => void;
};

type ActiveMiniTask = {
  id: string;
  task: string;
  prompt: (message: string) => Promise<RpcRecord>;
  abort: () => Promise<RpcRecord>;
  publish: () => void;
};

type MiniRpcRunCallbacks = {
  isExpanded?: () => boolean;
  onStart?: (task: ActiveMiniTask) => void;
  onDone?: (task: ActiveMiniTask) => void;
};

type MiniToolState = {
  id: string;
  name: string;
  status: "running" | "finished" | "failed";
  args?: unknown;
  result?: unknown;
};

type MiniLiveState = {
  assistantPreview?: string;
  tools: Map<string, MiniToolState>;
  events: string[];
};

function makeAbortError(): Error {
  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(makeAbortError());

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timeout);
      reject(makeAbortError());
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getRpcData(response: RpcRecord): Record<string, unknown> | undefined {
  return isRecord(response.data) ? response.data : undefined;
}

function getMessageText(message: unknown): string | undefined {
  if (!isRecord(message) || !Array.isArray(message.content)) return undefined;

  const parts: string[] = [];
  for (const block of message.content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }

  const text = parts.join("\n").trim();
  return text.length > 0 ? text : undefined;
}

function getAssistantStatus(message: unknown): { stopReason?: string; errorMessage?: string } {
  if (!isRecord(message)) return {};
  return {
    stopReason: typeof message.stopReason === "string" ? message.stopReason : undefined,
    errorMessage: typeof message.errorMessage === "string" ? message.errorMessage : undefined,
  };
}

function getLastAssistantMessage(messages: unknown): unknown {
  if (!Array.isArray(messages)) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (isRecord(message) && message.role === "assistant") return message;
  }
  return undefined;
}

function truncateLiveLine(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > 180 ? `${normalized.slice(0, 177)}...` : normalized;
}

function stringifyMiniValue(value: unknown, maxLength: number): string | undefined {
  if (value === undefined) return undefined;

  let text: string;
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }

  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) return undefined;
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 3)}...` : normalized;
}

function getToolArgSummary(tool: MiniToolState): string | undefined {
  if (!isRecord(tool.args)) return stringifyMiniValue(tool.args, 180);

  for (const key of ["command", "path", "name", "task", "query", "pattern"] as const) {
    const value = tool.args[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return `${key}: ${truncateLiveLine(value)}`;
    }
  }

  return stringifyMiniValue(tool.args, 180);
}

function getToolResultSummary(result: unknown): string | undefined {
  if (!isRecord(result)) return stringifyMiniValue(result, 240);

  if (Array.isArray(result.content)) {
    const parts: string[] = [];
    for (const block of result.content) {
      if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
        parts.push(block.text);
      }
    }
    const text = parts.join("\n").trim();
    if (text.length > 0) return truncateLiveLine(text);
  }

  return stringifyMiniValue(result, 240);
}

function formatLiveMiniTask(state: MiniLiveState, expanded: boolean): string {
  const lines = ["## Live minitask"];
  const tools = [...state.tools.values()];

  if (tools.length > 0) {
    lines.push("tools:");
    for (const tool of tools.slice(-MINI_LIVE_LINE_LIMIT)) {
      lines.push(`  - ${tool.name} ${tool.status}`);
      const args = getToolArgSummary(tool);
      if (args) lines.push(`    ${args}`);

      if (expanded) {
        const fullArgs = stringifyMiniValue(tool.args, 1000);
        if (fullArgs && fullArgs !== args) lines.push(`    args: ${fullArgs}`);
        const result = getToolResultSummary(tool.result);
        if (result) lines.push(`    result: ${result}`);
      }
    }
  }

  if (state.assistantPreview) {
    lines.push(`assistant: ${truncateLiveLine(state.assistantPreview)}`);
  }

  const remaining = MINI_LIVE_LINE_LIMIT - (lines.length - 1);
  if (remaining > 0 && state.events.length > 0) {
    lines.push(...state.events.slice(-remaining));
  }

  return lines.join("\n");
}

class MiniRpcProcess {
  private child: ChildProcessWithoutNullStreams;
  private onEvent: (record: RpcRecord) => void;
  private stdoutBuffer = "";
  private stderr = "";
  private nextRequestId = 1;
  private pending = new Map<string, PendingRpcRequest>();
  isStreaming = false;
  wasAborted = false;

  constructor(child: ChildProcessWithoutNullStreams, onEvent: (record: RpcRecord) => void) {
    this.child = child;
    this.onEvent = onEvent;

    this.child.stdout.on("data", (chunk: Buffer) => {
      this.handleStdout(chunk.toString("utf8"));
    });

    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderr += chunk.toString("utf8");
    });

    this.child.once("error", (error) => {
      for (const pending of this.pending.values()) {
        pending.reject(error);
      }
      this.pending.clear();
    });

    this.child.once("exit", (code, signal) => {
      const error = new Error(`mini pi exited (code=${code ?? "null"} signal=${signal ?? "null"}). ${this.stderr.trim()}`.trim());
      for (const pending of this.pending.values()) {
        pending.reject(error);
      }
      this.pending.clear();
    });
  }

  static start(cwd: string, args: string[], forkEnv: boolean, onEvent: (record: RpcRecord) => void): MiniRpcProcess {
    const child = spawn(forkEnv ? "env" : "pi", forkEnv ? ["PI_FORK=true", "pi", ...args] : args, {
      cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return new MiniRpcProcess(child, onEvent);
  }

  send(command: RpcRecord): Promise<RpcRecord> {
    if (this.child.exitCode !== null) {
      return Promise.reject(new Error(`mini pi is not running. ${this.stderr.trim()}`.trim()));
    }

    const id = `mini-${this.nextRequestId++}`;
    const payload = { ...command, id };

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
        if (!error) return;
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  async prompt(message: string): Promise<RpcRecord> {
    const response = await this.send(
      this.isStreaming
        ? { type: "prompt", message, streamingBehavior: "followUp" }
        : { type: "prompt", message },
    );
    if (response.success !== true) {
      throw new Error(response.error ?? "mini prompt failed");
    }
    return response;
  }

  async abort(): Promise<RpcRecord> {
    this.wasAborted = true;
    const response = await this.send({ type: "abort" });
    if (response.success !== true) {
      throw new Error(response.error ?? "mini abort failed");
    }
    return response;
  }

  async getState(): Promise<RpcRecord> {
    return this.send({ type: "get_state" });
  }

  async dispose(): Promise<void> {
    if (this.child.exitCode !== null) return;

    this.child.stdin.end();
    await Promise.race([
      new Promise<void>((resolve) => this.child.once("exit", () => resolve())),
      delay(1000).then(() => {
        if (this.child.exitCode === null) {
          this.child.kill("SIGTERM");
        }
      }),
    ]);
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;

    while (true) {
      const newlineIndex = this.stdoutBuffer.indexOf("\n");
      if (newlineIndex === -1) break;

      const line = this.stdoutBuffer.slice(0, newlineIndex).replace(/\r$/, "");
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line.trim().length === 0) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isRecord(parsed)) continue;

      const record = parsed as RpcRecord;
      if (record.type === "response" && typeof record.id === "string") {
        const pending = this.pending.get(record.id);
        if (pending) {
          this.pending.delete(record.id);
          pending.resolve(record);
        }
        continue;
      }

      if (record.type === "agent_start") this.isStreaming = true;
      if (record.type === "agent_end") this.isStreaming = false;
      this.onEvent(record);
    }
  }
}

async function waitForMiniIdle(mini: MiniRpcProcess, signal?: AbortSignal): Promise<void> {
  while (true) {
    if (signal?.aborted) throw makeAbortError();

    const response = await mini.getState();
    if (response.success === true) {
      const data = getRpcData(response);
      const isStreaming = data?.isStreaming === true;
      const pendingMessageCount = typeof data?.pendingMessageCount === "number" ? data.pendingMessageCount : 0;
      mini.isStreaming = isStreaming;
      if (!isStreaming && pendingMessageCount === 0) return;
    }

    await delay(300, signal);
  }
}

async function runPiRpcTask(
  task: string,
  cwd: string,
  baseArgs: string[],
  simple: boolean,
  signal: AbortSignal | undefined,
  onUpdate: ((update: { content: Array<{ type: "text"; text: string }>; details: unknown }) => void) | undefined,
  callbacks: MiniRpcRunCallbacks,
  forkEnv = false,
): Promise<PiPrintTaskRun> {
  let answer = "(no output)";
  let exitCode = 0;
  let usedArgs = baseArgs;

  for (const args of buildPiPrintAttempts(simple, baseArgs)) {
    usedArgs = args;
    const liveState: MiniLiveState = { tools: new Map(), events: [] };
    let lastAssistantText = "";
    let finalStopReason: string | undefined;
    let finalErrorMessage: string | undefined;

    const publishLiveState = () => {
      onUpdate?.({
        content: [{ type: "text", text: formatLiveMiniTask(liveState, callbacks.isExpanded?.() === true) }],
        details: {
          args,
          expanded: callbacks.isExpanded?.() === true,
          tools: [...liveState.tools.values()],
          events: liveState.events.slice(-MINI_LIVE_LINE_LIMIT),
        },
      });
    };

    const addLiveEvent = (line: string) => {
      liveState.events.push(line);
      publishLiveState();
    };

    const setAssistantPreview = (text: string) => {
      liveState.assistantPreview = text;
      publishLiveState();
    };

    const mini = MiniRpcProcess.start(cwd, args, forkEnv, (record) => {
      if (record.type === "tool_execution_start") {
        const toolCallId = typeof record.toolCallId === "string" ? record.toolCallId : `tool-${liveState.tools.size + 1}`;
        liveState.tools.set(toolCallId, {
          id: toolCallId,
          name: typeof record.toolName === "string" ? record.toolName : "unknown",
          status: "running",
          args: record.args,
        });
        publishLiveState();
        return;
      }

      if (record.type === "tool_execution_end") {
        const toolCallId = typeof record.toolCallId === "string" ? record.toolCallId : `tool-${liveState.tools.size + 1}`;
        const existing = liveState.tools.get(toolCallId);
        liveState.tools.set(toolCallId, {
          id: toolCallId,
          name: typeof record.toolName === "string" ? record.toolName : existing?.name ?? "unknown",
          status: record.isError === true ? "failed" : "finished",
          args: record.args ?? existing?.args,
          result: record.result,
        });
        publishLiveState();
        return;
      }

      if (record.type === "queue_update") {
        const followUpCount = Array.isArray(record.followUp) ? record.followUp.length : 0;
        if (followUpCount > 0) addLiveEvent(`follow-up queue: ${followUpCount}`);
        return;
      }

      if (record.type === "message_update") {
        const text = getMessageText(record.message);
        if (text) setAssistantPreview(text);
        return;
      }

      if (record.type === "message_end") {
        const text = getMessageText(record.message);
        if (text) lastAssistantText = text;
        const status = getAssistantStatus(record.message);
        finalStopReason = status.stopReason ?? finalStopReason;
        finalErrorMessage = status.errorMessage ?? finalErrorMessage;
        return;
      }

      if (record.type === "agent_end") {
        const assistant = getLastAssistantMessage(record.messages);
        const text = getMessageText(assistant);
        if (text) lastAssistantText = text;
        const status = getAssistantStatus(assistant);
        finalStopReason = status.stopReason ?? finalStopReason;
        finalErrorMessage = status.errorMessage ?? finalErrorMessage;
        publishLiveState();
      }
    });

    const activeTask: ActiveMiniTask = {
      id: `mini-${Date.now()}`,
      task,
      prompt: (message) => mini.prompt(message),
      abort: () => mini.abort(),
      publish: publishLiveState,
    };

    callbacks.onStart?.(activeTask);

    try {
      publishLiveState();
      const response = await mini.prompt(task);
      if (response.success !== true) {
        throw new Error(response.error ?? "mini prompt failed");
      }

      await delay(100, signal);
      await waitForMiniIdle(mini, signal);

      answer = finalErrorMessage ?? (lastAssistantText || "(no output)");
      exitCode = finalStopReason === "error" || finalStopReason === "aborted" || mini.wasAborted ? 1 : 0;
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw err;
      }
      answer = err instanceof Error ? err.message : String(err);
      exitCode = 1;
    } finally {
      callbacks.onDone?.(activeTask);
      await mini.dispose();
    }

    if (mini.wasAborted || !simple || exitCode === 0) break;
  }

  return { task, answer, exitCode, args: usedArgs };
}

function assistantHasToolCall(message: AssistantMessage): boolean {
  return message.content.some((content) => content.type === "toolCall");
}

function pruneUnresolvedToolCallTail(entries: SessionEntry[]): SessionEntry[] {
  let pendingToolCallIds = new Set<string>();
  let pendingStartIndex: number | undefined;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.type !== "message") continue;

    if (entry.message.role === "assistant") {
      if (assistantHasToolCall(entry.message)) {
        pendingToolCallIds = new Set(
          entry.message.content
            .filter((content) => content.type === "toolCall")
            .map((content) => content.id),
        );
        pendingStartIndex = i;
      } else if (pendingToolCallIds.size > 0) {
        pendingToolCallIds = new Set();
        pendingStartIndex = undefined;
      }
      continue;
    }

    if (entry.message.role === "toolResult") {
      pendingToolCallIds.delete(entry.message.toolCallId);
      if (pendingToolCallIds.size === 0) {
        pendingStartIndex = undefined;
      }
      continue;
    }

    if (entry.message.role === "user" && pendingToolCallIds.size > 0) {
      pendingToolCallIds = new Set();
      pendingStartIndex = undefined;
    }
  }

  return pendingToolCallIds.size > 0 && pendingStartIndex !== undefined
    ? entries.slice(0, pendingStartIndex)
    : entries;
}

async function createTempforkFiles(header: SessionHeader, entries: SessionEntry[], task: string): Promise<TempforkFiles> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-tempfork-"));
  const snapshotFile = path.join(root, "snapshot.jsonl");
  const promptFile = path.join(root, "prompt.md");
  const sessionDir = path.join(root, "sessions");
  const snapshotEntries: Array<SessionHeader | SessionEntry> = [header, ...pruneUnresolvedToolCallTail(entries)];

  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(snapshotFile, `${snapshotEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
  await fs.writeFile(promptFile, task, "utf8");

  return { root, snapshotFile, promptFile, sessionDir };
}

export default function (pi: ExtensionAPI) {
  let activeMiniTask: ActiveMiniTask | undefined;
  let miniTaskExpanded = false;

  pi.on("session_start", async (_event, ctx) => {
    if (!isTmuxAvailable()) {
      ctx.ui.notify(
        "tmux extension: Not running in tmux session (TMUX env not set)",
        "warning",
      );
    }
  });

  pi.registerTool({
    name: "tmux-bash",
    label: "Tmux Bash",
    description:
      "Create a new tmux pane with the given lock name and execute a command. Use ONLY for long-running processes (servers, watch commands, builds >30s).",
    parameters: tmuxBashParams,
    async execute(_toolCallId, params, signal) {
      const args = params.command
        ? ["bash", params.name, params.command]
        : ["bash", params.name];
      const result = await runTmux(pi, args, signal);
      const text = outputText(result.stdout, result.stderr);

      if (result.code !== 0) {
        throw new Error(text);
      }

      return {
        content: [{ type: "text", text }],
        details: { code: result.code, args },
      };
    },
  });

  pi.registerTool({
    name: "tmux-capture",
    label: "Tmux Capture",
    description:
      "Capture output from a tmux pane by lock name or pane id. By default, returns only new lines since the last capture (up to 500). Pass lines: <number> to get the last N lines regardless.",
    parameters: tmuxCaptureParams,
    async execute(_toolCallId, params, signal) {
      const explicitLines = params.lines;
      const maxLines = explicitLines ?? DEFAULT_MAX_NEW;
      const paneIdResult = await runTmux(pi, ["pane-id", params.name], signal);
      const paneId = paneIdResult.code === 0 ? paneIdResult.stdout.trim() : undefined;
      const stateKey = paneId ? `${params.name}:${paneId}` : params.name;

      let text: string;
      let resultCode: number;
      let resultArgs: string[];

      /** Helper: get current line count from tmux */
      const getLineCount = async () => {
        const r = await runTmux(pi, ["line-count", params.name], signal);
        if (r.code !== 0) return undefined;
        const n = parseInt(r.stdout.trim(), 10);
        return isNaN(n) ? undefined : n;
      };

      /** Helper: do a normal capture of N lines */
      const doCapture = async (n: number) => {
        const args = ["capture", params.name, String(n)];
        const r = await runTmux(pi, args, signal);
        return { args, result: r };
      };

      /** Helper: update stored line count */
      const updateState = async () => {
        const lc = await getLineCount();
        if (lc !== undefined) captureState.set(stateKey, lc);
      };

      if (explicitLines !== undefined) {
        // Explicit lines: old behavior, return last N lines
        const { args, result } = await doCapture(explicitLines);
        resultArgs = args;
        text = outputText(result.stdout, result.stderr);
        resultCode = result.code;

        if (resultCode !== 0) {
          throw new Error(text);
        }

        await updateState();
      } else {
        // New-only mode (default)
        const currentTotal = await getLineCount();

        if (currentTotal === undefined) {
          // Can't get line count — fallback to normal capture
          const { args, result } = await doCapture(maxLines);
          resultArgs = args;
          text = outputText(result.stdout, result.stderr);
          resultCode = result.code;

          if (resultCode !== 0) {
            throw new Error(text);
          }
        } else {
          const prev = captureState.get(stateKey);

          if (prev === undefined || currentTotal < prev) {
            // No prior state or pane was reset — full capture
            const { args, result } = await doCapture(maxLines);
            resultArgs = args;
            text = outputText(result.stdout, result.stderr);
            resultCode = result.code;

            if (resultCode !== 0) {
              throw new Error(text);
            }
          } else {
            const delta = currentTotal - prev;

            if (delta === 0) {
              text = "(no new output)";
              resultCode = 0;
              resultArgs = ["line-count", params.name];

              // Still set up watch if requested, then return
              let watchLock: string | undefined;
              if (params.watch) {
                const watchArgs = ["watch", params.name, params.watch];
                const watchResult = await runTmux(pi, watchArgs, signal);
                const watchText = watchResult.stdout.trim();
                if (watchResult.code !== 0) {
                  text += `\n\n⚠️ Watch setup failed: ${outputText(watchResult.stdout, watchResult.stderr)}`;
                } else {
                  const match = watchText.match(/lock '([^']+)'/);
                  watchLock = match?.[1];
                  text += `\n\n${watchText}`;
                }
              }

              return {
                content: [{ type: "text", text }],
                details: { code: resultCode, args: resultArgs, watchLock },
              };
            }

            // Capture exactly the new lines (capped at maxLines)
            const captureLines = Math.min(delta, maxLines);
            const { args, result } = await doCapture(captureLines);
            resultArgs = args;
            resultCode = result.code;

            if (resultCode !== 0) {
              text = outputText(result.stdout, result.stderr);
              throw new Error(text);
            }

            if (delta > maxLines) {
              text = `⚠️ ${delta} new lines, showing last ${maxLines}. Use lines: ${delta} to see all.\n\n${outputText(result.stdout, result.stderr)}`;
            } else {
              text = outputText(result.stdout, result.stderr);
            }

            if (!text) text = "(no new output)";
            resultCode = 0;
          }
        }

        await updateState();
      }

      // Set up a watch if requested
      let watchLock: string | undefined;
      if (params.watch) {
        const watchArgs = ["watch", params.name, params.watch];
        const watchResult = await runTmux(pi, watchArgs, signal);
        const watchText = watchResult.stdout.trim();

        if (watchResult.code !== 0) {
          text += `\n\n⚠️ Watch setup failed: ${outputText(watchResult.stdout, watchResult.stderr)}`;
        } else {
          // Extract the lock name from the watch output
          const match = watchText.match(/lock '([^']+)'/);
          watchLock = match?.[1];
          text += `\n\n${watchText}`;
        }
      }

      return {
        content: [{ type: "text", text }],
        details: { code: resultCode, args: resultArgs!, watchLock },
      };
    },
  });

  pi.registerTool({
    name: "tmux-send",
    label: "Tmux Send",
    description:
      "Send text or keys to a tmux pane by lock name or pane id. For workflows that wait on completion, pair with semaphore_wait on the same lock name.",
    parameters: tmuxSendParams,
    async execute(_toolCallId, params, signal) {
      const args = [
        "send",
        params.name,
        ...(params.enter === false ? ["--no-enter"] : []),
        params.text,
      ];
      const result = await runTmux(pi, args, signal);
      const text = outputText(result.stdout, result.stderr);

      if (result.code !== 0) {
        throw new Error(text);
      }

      return {
        content: [{ type: "text", text }],
        details: { code: result.code, args },
      };
    },
  });

  pi.registerTool({
    name: "tmux-kill",
    label: "Tmux Kill",
    description: "Kill a tmux pane by lock name or pane id.",
    parameters: tmuxKillParams,
    async execute(_toolCallId, params, signal) {
      clearCaptureStateForTarget(params.name);
      const args = ["kill", params.name];
      const result = await runTmux(pi, args, signal);
      const text = outputText(result.stdout, result.stderr);

      if (result.code !== 0) {
        throw new Error(text);
      }

      return {
        content: [{ type: "text", text }],
        details: { code: result.code, args },
      };
    },
  });

  pi.registerTool({
    name: "tmux-coding-agent",
    label: "Tmux Coding Agent",
    description:
      "Spawn a pi coding agent in a tmux pane using the given lock name and folder. " +
      "Send work via tmux-send('<name>'), wait for completion via semaphore_wait('<name>').",
    parameters: tmuxCodingAgentParams,
    async execute(_toolCallId, params, signal) {
      const args = ["coding-agent", params.name, params.folder];
      if (params.contextAlertPercent !== undefined) {
        args.push("--context-alert", String(params.contextAlertPercent));
      }
      if (params.piArgs) {
        args.push(params.piArgs);
      }

      const result = await runTmux(pi, args, signal);
      const text = outputText(result.stdout, result.stderr);

      if (result.code !== 0) {
        throw new Error(text);
      }

      return {
        content: [{ type: "text", text }],
        details: { code: result.code, args },
      };
    },
  });

  pi.registerTool({
    name: "minitask",
    label: "Minitask",
    description:
      "Run one isolated small task or question about this project/environment with an isolated pi RPC process. " +
      "For multiple independent tasks, call this tool multiple times in parallel; do not put dependent followups here because each run has no shared context.",
    parameters: minitaskParams,
    renderCall(args) {
      const payloadValue = args.task === undefined
        ? args
        : args.simple === true
          ? { task: args.task, simple: true }
          : args.task;
      const payload = JSON.stringify(payloadValue, null, 2) ?? String(payloadValue);
      const lines = ["minitask(", ...payload.split("\n").map((line) => `  ${line}`), ")"];

      return {
        render: (contentWidth: number) => lines.flatMap((line) => wrapTextWithAnsi(line, contentWidth)),
        invalidate: () => {
          /* no-op */
        },
      };
    },
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const result = await runPiRpcTask(
        params.task,
        ctx.cwd,
        ["--mode", "rpc"],
        params.simple === true,
        signal,
        onUpdate,
        {
          isExpanded: () => miniTaskExpanded,
          onStart(task) {
            activeMiniTask = task;
          },
          onDone(task) {
            if (activeMiniTask?.id === task.id) {
              activeMiniTask = undefined;
            }
          },
        },
      );
      const text = formatMinitaskResult(result);

      return {
        content: [{ type: "text", text }],
        details: {
          simple: params.simple === true,
          result,
          args: result.args,
        },
      };
    },
  });

  pi.registerTool({
    name: "tempfork",
    label: "Tempfork",
    description:
      "Run one isolated small task or question in a temporary fork of the current session with pi -p. " +
      "Use when the task needs this conversation's context but should not modify the current session.",
    promptSnippet: "Run a one-shot pi -p task in a temporary fork of the current session",
    promptGuidelines: [
      "Use tempfork for independent one-shot questions that need the current session context; use minitask when no current-session context is needed.",
      "Do not use tempfork for dependent follow-up work because each tempfork runs in its own temporary session and exits.",
    ],
    parameters: tempforkParams,
    renderCall(args) {
      const payloadValue = args.task === undefined
        ? args
        : args.simple === true || args.keepSession === true || args.folder !== undefined
          ? {
              task: args.task,
              ...(args.folder !== undefined ? { folder: args.folder } : {}),
              ...(args.simple === true ? { simple: true } : {}),
              ...(args.keepSession === true ? { keepSession: true } : {}),
            }
          : args.task;
      const payload = JSON.stringify(payloadValue, null, 2) ?? String(payloadValue);
      const lines = ["tempfork(", ...payload.split("\n").map((line) => `  ${line}`), ")"];

      return {
        render: (contentWidth: number) => lines.flatMap((line) => wrapTextWithAnsi(line, contentWidth)),
        invalidate: () => {
          /* no-op */
        },
      };
    },
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (PI_FORK) {
        return {
          content: [{ type: "text", text: FORK_BLOCK_MESSAGE }],
          details: { blocked: true, reason: "PI_FORK=true" },
          terminate: true,
        };
      }

      const header = ctx.sessionManager.getHeader();
      if (!header) {
        throw new Error("Current session has no header; cannot create tempfork");
      }

      const cwd = path.resolve(ctx.cwd, params.folder ?? ".");
      let files: TempforkFiles | undefined;
      let result: PiPrintTaskRun | undefined;

      try {
        files = await createTempforkFiles(header, ctx.sessionManager.getBranch(), params.task);
        result = await runPiPrintTask(
          pi,
          params.task,
          cwd,
          ["--fork", files.snapshotFile, "--session-dir", files.sessionDir, "-p", `@${files.promptFile}`],
          params.simple === true,
          signal,
          true,
        );
      } finally {
        if (files && params.keepSession !== true) {
          await fs.rm(files.root, { recursive: true, force: true });
        }
      }

      if (!result) {
        throw new Error("tempfork did not produce a result");
      }

      const text = formatMinitaskResult(result);

      return {
        content: [{ type: "text", text }],
        details: {
          simple: params.simple === true,
          kept: params.keepSession === true,
          files: params.keepSession === true ? files : undefined,
          result,
          args: result.args,
        },
      };
    },
  });

  pi.registerCommand("expand-minitask", {
    description: "Toggle expanded live rendering for active minitask tools.",
    handler: async (_args, ctx) => {
      miniTaskExpanded = !miniTaskExpanded;
      activeMiniTask?.publish();
      ctx.ui.notify(`Minitask expanded: ${miniTaskExpanded ? "on" : "off"}`, "info");
    },
  });

  pi.registerCommand("prompt-mini", {
    description: "Send a prompt to the active minitask RPC process. Usage: /prompt-mini <message>",
    handler: async (args, ctx) => {
      const message = (args ?? "").trim();
      if (!message) {
        ctx.ui.notify("Usage: /prompt-mini <message>", "warning");
        return;
      }

      if (!activeMiniTask) {
        ctx.ui.notify("No active minitask", "warning");
        return;
      }

      try {
        await activeMiniTask.prompt(message);
        ctx.ui.notify("Sent prompt to active minitask", "info");
      } catch (err) {
        ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
      }
    },
  });

  pi.registerCommand("abort-mini", {
    description: "Abort the active minitask RPC process.",
    handler: async (_args, ctx) => {
      if (!activeMiniTask) {
        ctx.ui.notify("No active minitask", "warning");
        return;
      }

      try {
        await activeMiniTask.abort();
        ctx.ui.notify("Aborted active minitask", "info");
      } catch (err) {
        ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
      }
    },
  });

  pi.registerCommand("clear-stale", {
    description: "Clean up semaphore lock files and state for dead tmux panes",
    handler: async (_args, ctx) => {
      const result = await runTmux(pi, ["clear-stale"]);
      const text = outputText(result.stdout, result.stderr);
      ctx.ui.notify(text, result.code === 0 ? "info" : "error");
    },
  });

  pi.registerCommand("tmux-list", {
    description: "List active tmux panes",
    handler: async (_args, ctx) => {
      const result = await runTmux(pi, ["list"]);
      const text = outputText(result.stdout, result.stderr);
      ctx.ui.notify(text, result.code === 0 ? "info" : "error");
    },
  });
}
