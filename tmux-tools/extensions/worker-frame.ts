import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentEndEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isRetryableAssistantErrorMessage, RETRY_START_GRACE_MS } from "./retryable-errors.ts";
import { runTmux } from "./tmux-helpers.ts";

const WORKER_ROOT_PREFIX = "pi-tmux-worker-";
const WORKER_RUN_COMMAND = "worker-run";
const FINISH_CALL_NOW_COMMAND = "finish-call-now";
const RESULT_POLL_INTERVAL_MS = 250;
const PROGRESS_UPDATE_INTERVAL_MS = 5000;
const PANE_STATE_POLL_INTERVAL_MS = 1000;
const PANE_MISSING_GRACE_MS = 5000;

const RETROSPECTIVE_PROMPT = [
  "The main result has already been saved for the parent. Do not repeat it, do not continue the task, and do not call tools.",
  "Return only substantial observations you noticed outside of the given task, or substantial things you did not mention regarding it, that are worth taking into account or fixing in the long run.",
  "If there is nothing substantial, return exactly: everything was ok",
].join("\n");

export interface WorkerRequestFile {
  id: string;
  task: string;
  resultPath: string;
  closeWhenDone: boolean;
  statusPath?: string;
}

export interface WorkerResultFile {
  id: string;
  result: string;
  retrospective?: string;
  isError?: boolean;
  sessionFile?: string;
  timestamp: string;
  contextPercent?: number | null;
}

export interface WorkerStatusFile {
  id?: string;
  state: "idle" | "running" | "retrospective" | "error" | "closed";
  resultPath?: string;
  sessionFile?: string;
  contextPercent?: number | null;
  updatedAt: string;
}

export interface WorkerArtifactPaths {
  artifactDir: string;
  requestPath: string;
  resultPath: string;
  statusPath: string;
  promptPath: string;
  resultMarkdownPath: string;
  retrospectiveMarkdownPath: string;
}

interface ActiveWorkerRequest {
  request: WorkerRequestFile;
  priorTools: string[];
  mainResult?: string;
  retryFailureTimer?: ReturnType<typeof setTimeout>;
}

interface WorkerToolDetails {
  id: string;
  lockName: string;
  requestedLockName: string;
  resultPath: string;
  artifactDir: string;
  requestPath: string;
  resultMarkdownPath: string;
  retrospectiveMarkdownPath: string;
  sessionFile: string;
  task: string;
  elapsedMs?: number;
  status?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFreshWorkerSession(ctx: ExtensionContext): boolean {
  return ctx.sessionManager.getBranch().some((entry) => {
    return isRecord(entry)
      && entry.type === "custom"
      && (entry.customType === "pi-tmux:coding-agent" || entry.customType === "pi-tmux:minitask");
  });
}

function stripSubagentTools(tools: string[]): string[] {
  return tools.filter((tool) => tool !== "call" && tool !== "coding-agent" && tool !== "minitask");
}

function isWorkerRequestFile(value: unknown): value is WorkerRequestFile {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.task === "string"
    && typeof value.resultPath === "string"
    && typeof value.closeWhenDone === "boolean"
    && (value.statusPath === undefined || typeof value.statusPath === "string");
}

function isWorkerResultFile(value: unknown): value is WorkerResultFile {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.result === "string"
    && typeof value.timestamp === "string"
    && (value.retrospective === undefined || typeof value.retrospective === "string")
    && (value.isError === undefined || typeof value.isError === "boolean")
    && (value.sessionFile === undefined || typeof value.sessionFile === "string")
    && (value.contextPercent === undefined || typeof value.contextPercent === "number" || value.contextPercent === null);
}

function latestAssistantMessage(messages: AgentEndEvent["messages"]): Extract<AgentEndEvent["messages"][number], { role: "assistant" }> | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role === "assistant") return message;
  }
  return undefined;
}

function assistantTextContent(message: Extract<AgentEndEvent["messages"][number], { role: "assistant" }>): string | undefined {
  const text = message.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("")
    .trim();
  return text || undefined;
}

function assistantMessageText(message: Extract<AgentEndEvent["messages"][number], { role: "assistant" }>): string {
  return assistantTextContent(message) ?? message.errorMessage ?? `Assistant stopped with reason '${message.stopReason}' before returning a final worker result.`;
}

function isRetryableAssistantFailure(message: Extract<AgentEndEvent["messages"][number], { role: "assistant" }>): boolean {
  return message.stopReason === "error" && isRetryableAssistantErrorMessage(message.errorMessage);
}

function getContextPercent(ctx: ExtensionContext): number | null | undefined {
  return ctx.getContextUsage()?.percent;
}

function writeTextArtifact(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, content, { encoding: "utf8", mode: 0o600 });
}

function atomicWriteJsonNoOverwrite(filePath: string, payload: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try {
    fs.linkSync(tmp, filePath);
  } catch (error) {
    if (isRecord(error) && error.code === "EEXIST") {
      throw new Error(`Worker result already exists: ${filePath}`);
    }
    throw error;
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // ignore cleanup failure
    }
  }
}

function atomicWriteJson(filePath: string, payload: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

function appendRetrospective(result: string, retrospective: string): string {
  return [result.trimEnd(), "", "---", "", "Retrospective:", retrospective.trim()].join("\n");
}

function parseFinishText(args: string | undefined): string {
  const trimmed = (args ?? "").trim();
  if (trimmed.length < 2) return trimmed;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function makeWorkerId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function sanitizeWorkerName(name: string): string {
  return name.replace(/[^A-Za-z0-9._:-]/g, "");
}

export function createWorkerArtifacts(id: string): WorkerArtifactPaths {
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), WORKER_ROOT_PREFIX));
  fs.chmodSync(artifactDir, 0o700);
  return {
    artifactDir,
    requestPath: path.join(artifactDir, "request.json"),
    resultPath: path.join(artifactDir, "result.json"),
    statusPath: path.join(artifactDir, "status.json"),
    promptPath: path.join(artifactDir, "prompt.md"),
    resultMarkdownPath: path.join(artifactDir, "result.md"),
    retrospectiveMarkdownPath: path.join(artifactDir, "retrospective.md"),
  };
}

export function formatWorkerMoreInfo(paths: WorkerArtifactPaths): string {
  const usefulFiles = [
    "prompt.md",
    "result.md",
    "retrospective.md",
    "request.json",
    "result.json",
    "status.json",
  ];
  return [`More info in ${paths.artifactDir}`, `Useful files: ${usefulFiles.join(", ")}`].join("\n");
}

export function appendWorkerMoreInfo(message: string, paths: WorkerArtifactPaths): string {
  const trimmed = message.trimEnd();
  if (!trimmed) return formatWorkerMoreInfo(paths);
  if (trimmed.includes(paths.artifactDir)) return trimmed;
  return `${trimmed}\n\n${formatWorkerMoreInfo(paths)}`;
}

export function writeWorkerRequest(paths: WorkerArtifactPaths, request: WorkerRequestFile): void {
  atomicWriteJson(paths.requestPath, request);
  const prompt = ["# Prompt", "", request.task, "", "# Worker command", "", `/worker-run ${paths.requestPath}`, ""].join("\n");
  fs.writeFileSync(paths.promptPath, prompt, { encoding: "utf8", mode: 0o600 });
}

export function readWorkerStatus(statusPath: string): WorkerStatusFile | undefined {
  if (!fs.existsSync(statusPath)) return undefined;
  const parsed = JSON.parse(fs.readFileSync(statusPath, "utf8")) as unknown;
  if (!isRecord(parsed) || typeof parsed.state !== "string" || typeof parsed.updatedAt !== "string") return undefined;
  return parsed as unknown as WorkerStatusFile;
}

export function writeWorkerStatus(statusPath: string | undefined, status: Omit<WorkerStatusFile, "updatedAt">): void {
  if (!statusPath) return;
  atomicWriteJson(statusPath, { ...status, updatedAt: new Date().toISOString() });
}

export function parseActualLockName(text: string, requestedLockName: string): string {
  const machineMatch = text.match(/^PI_TMUX_LOCK_NAME=([^\s]+)$/m);
  if (machineMatch) return machineMatch[1];
  const statusMatch = text.match(/Started tmux fork '([^']+)'/);
  if (statusMatch) return statusMatch[1];
  return requestedLockName;
}

export function formatWorkerResult(result: WorkerResultFile): string {
  if (result.retrospective !== undefined) return appendRetrospective(result.result, result.retrospective);
  return result.result;
}

export function parseWorkerResult(raw: string, resultPath: string, expectedId: string): WorkerResultFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid worker result JSON at ${resultPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isWorkerResultFile(parsed)) {
    throw new Error(`Invalid worker result shape at ${resultPath}`);
  }
  if (parsed.id !== expectedId) {
    throw new Error(`Worker result id mismatch at ${resultPath}: expected ${expectedId}, got ${parsed.id}`);
  }
  return parsed;
}

export async function captureWorkerOutput(pi: ExtensionAPI, lockName: string, lines = 80, signal?: AbortSignal): Promise<string> {
  try {
    const result = await runTmux(pi, ["capture", lockName, String(lines)], signal);
    const text = result.stdout.trimEnd() || result.stderr.trimEnd();
    return text || "(no tmux output)";
  } catch (error) {
    throwIfAborted(signal);
    return `Could not capture tmux output for ${lockName}: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function waitForWorkerReady(pi: ExtensionAPI, lockName: string, timeoutMs = 10_000, signal?: AbortSignal): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    throwIfAborted(signal);
    const output = await captureWorkerOutput(pi, lockName, 30, signal);
    if (/\bpi v\d+\.\d+\.\d+\b|Model scope:|Ask it how to use or extend Pi/.test(output)) return;
    await delay(300);
  }
  throwIfAborted(signal);
}

interface WorkerPaneState {
  state: "live" | "dead" | "missing";
  paneId?: string;
  text: string;
}

function parseWorkerPaneState(stdout: string, stderr: string, code: number): WorkerPaneState {
  const text = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
  const state = text.match(/^state=(live|dead|missing)$/m)?.[1];
  const paneId = text.match(/^pane=(%\d+)$/m)?.[1];
  if (code !== 0 || (state !== "live" && state !== "dead" && state !== "missing")) return { state: "missing", text };
  return { state, paneId, text };
}

async function readWorkerPaneState(pi: ExtensionAPI, lockName: string, signal?: AbortSignal): Promise<WorkerPaneState> {
  try {
    const result = await runTmux(pi, ["pane-state", lockName], signal);
    return parseWorkerPaneState(result.stdout, result.stderr, result.code);
  } catch (error) {
    throwIfAborted(signal);
    return { state: "missing", text: error instanceof Error ? error.message : String(error) };
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("Worker wait aborted.");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForWorkerResult(
  pi: ExtensionAPI,
  options: {
    id: string;
    actualLockName: string;
    requestedLockName: string;
    paths: WorkerArtifactPaths;
    sessionFile: string;
    task: string;
    signal?: AbortSignal;
    onUpdate?: (partial: { content: Array<{ type: "text"; text: string }>; details: WorkerToolDetails }) => void;
  },
): Promise<{ result: WorkerResultFile; details: WorkerToolDetails }> {
  const startedAt = Date.now();
  let lastProgressAt = 0;
  let lastPaneStateCheckAt = -PANE_STATE_POLL_INTERVAL_MS;
  let paneMissingSince: number | undefined;
  let lastKnownPaneId: string | undefined;
  let hasSeenLivePane = false;

  while (true) {
    throwIfAborted(options.signal);
    if (fs.existsSync(options.paths.resultPath)) {
      const result = parseWorkerResult(fs.readFileSync(options.paths.resultPath, "utf8"), options.paths.resultPath, options.id);
      return {
        result,
        details: {
          id: options.id,
          lockName: options.actualLockName,
          requestedLockName: options.requestedLockName,
          resultPath: options.paths.resultPath,
          artifactDir: options.paths.artifactDir,
          requestPath: options.paths.requestPath,
          resultMarkdownPath: options.paths.resultMarkdownPath,
          retrospectiveMarkdownPath: options.paths.retrospectiveMarkdownPath,
          sessionFile: options.sessionFile,
          task: options.task,
          elapsedMs: Date.now() - startedAt,
          status: "finished",
        },
      };
    }

    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs - lastPaneStateCheckAt >= PANE_STATE_POLL_INTERVAL_MS) {
      lastPaneStateCheckAt = elapsedMs;
      const paneState = await readWorkerPaneState(pi, options.actualLockName, options.signal);
      if (paneState.paneId) lastKnownPaneId = paneState.paneId;
      if (paneState.state === "live") {
        hasSeenLivePane = true;
        paneMissingSince = undefined;
      } else if (paneState.state === "dead") {
        const output = await captureWorkerOutput(pi, paneState.paneId ?? options.actualLockName, 80, options.signal);
        throw new Error([
          "Worker exited before writing a final result.",
          `tmux lock: ${options.actualLockName}`,
          `tmux pane: ${paneState.paneId ?? "unknown"}`,
          `session: ${options.sessionFile}`,
          `result path: ${options.paths.resultPath}`,
          "",
          "Last tmux output:",
          output,
        ].join("\n"));
      } else {
        paneMissingSince ??= Date.now();
        if (hasSeenLivePane || Date.now() - paneMissingSince >= PANE_MISSING_GRACE_MS) {
          throw new Error([
            "Worker pane disappeared before writing a final result.",
            `tmux lock: ${options.actualLockName}`,
            `tmux pane: ${lastKnownPaneId ?? "unknown"}`,
            `session: ${options.sessionFile}`,
            `result path: ${options.paths.resultPath}`,
            `waited after missing: ${Math.floor((Date.now() - paneMissingSince) / 1000)}s`,
            "",
            "Pane state:",
            paneState.text || "(missing)",
          ].join("\n"));
        }
      }
    }

    if (options.onUpdate && elapsedMs - lastProgressAt >= PROGRESS_UPDATE_INTERVAL_MS) {
      lastProgressAt = elapsedMs;
      const output = await captureWorkerOutput(pi, lastKnownPaneId ?? options.actualLockName, 12, options.signal);
      options.onUpdate({
        content: [{ type: "text", text: [`Waiting for worker ${options.actualLockName} (${Math.floor(elapsedMs / 1000)}s elapsed).`, `Session: ${options.sessionFile}`, "", output].join("\n") }],
        details: {
          id: options.id,
          lockName: options.actualLockName,
          requestedLockName: options.requestedLockName,
          resultPath: options.paths.resultPath,
          artifactDir: options.paths.artifactDir,
          requestPath: options.paths.requestPath,
          resultMarkdownPath: options.paths.resultMarkdownPath,
          retrospectiveMarkdownPath: options.paths.retrospectiveMarkdownPath,
          sessionFile: options.sessionFile,
          task: options.task,
          elapsedMs,
          status: "waiting",
        },
      });
    }

    await delay(RESULT_POLL_INTERVAL_MS);
    throwIfAborted(options.signal);
  }
}

function writeFinalResult(ctx: ExtensionContext, active: ActiveWorkerRequest, result: string, isError = false, retrospective?: string): void {
  const contextPercent = getContextPercent(ctx);
  const paths = {
    resultMarkdownPath: path.join(path.dirname(active.request.resultPath), "result.md"),
    retrospectiveMarkdownPath: path.join(path.dirname(active.request.resultPath), "retrospective.md"),
  };
  writeTextArtifact(paths.resultMarkdownPath, result);
  if (retrospective !== undefined) writeTextArtifact(paths.retrospectiveMarkdownPath, retrospective);

  const payload: WorkerResultFile = {
    id: active.request.id,
    result,
    retrospective,
    isError,
    sessionFile: ctx.sessionManager.getSessionFile() ?? undefined,
    timestamp: new Date().toISOString(),
    contextPercent: contextPercent ?? null,
  };
  atomicWriteJsonNoOverwrite(active.request.resultPath, payload);
  writeWorkerStatus(active.request.statusPath, {
    id: active.request.id,
    state: active.request.closeWhenDone ? "closed" : "idle",
    resultPath: active.request.resultPath,
    sessionFile: ctx.sessionManager.getSessionFile() ?? undefined,
    contextPercent: contextPercent ?? null,
  });
}

export default function workerFrameExtension(pi: ExtensionAPI): void {
  let activeRequest: ActiveWorkerRequest | undefined;

  function refreshFreshWorkerTools(ctx: ExtensionContext): void {
    if (isFreshWorkerSession(ctx)) {
      pi.setActiveTools(stripSubagentTools(pi.getActiveTools()));
    }
  }

  function clearRetryFailureTimer(request: ActiveWorkerRequest): void {
    if (request.retryFailureTimer) {
      clearTimeout(request.retryFailureTimer);
      request.retryFailureTimer = undefined;
    }
  }

  function completeWorkerRequest(ctx: ExtensionContext, request: ActiveWorkerRequest, result: string, isError = false, retrospective?: string): void {
    clearRetryFailureTimer(request);
    writeFinalResult(ctx, request, result, isError, retrospective);
    const shouldClose = request.request.closeWhenDone;
    activeRequest = undefined;
    if (shouldClose) ctx.shutdown();
  }

  function scheduleRetryableFailure(ctx: ExtensionContext, request: ActiveWorkerRequest, complete: () => void): void {
    clearRetryFailureTimer(request);
    request.retryFailureTimer = setTimeout(() => {
      request.retryFailureTimer = undefined;
      if (activeRequest !== request || fs.existsSync(request.request.resultPath)) return;
      try {
        complete();
      } catch (error) {
        ctx.ui.notify(`Failed to report retry-exhausted worker failure: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    }, RETRY_START_GRACE_MS);
    request.retryFailureTimer.unref?.();
  }

  pi.on("session_start", async (_event, ctx) => {
    refreshFreshWorkerTools(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    refreshFreshWorkerTools(ctx);
  });

  pi.on("agent_start", async () => {
    if (activeRequest) clearRetryFailureTimer(activeRequest);
  });

  pi.on("session_shutdown", async () => {
    if (activeRequest) clearRetryFailureTimer(activeRequest);
  });

  pi.registerCommand(WORKER_RUN_COMMAND, {
    description: "Internal worker command. Usage: /worker-run <request.json>",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();
      const requestPath = args.trim();
      if (!requestPath) {
        ctx.ui.notify("Usage: /worker-run <request.json>", "warning");
        return;
      }
      if (activeRequest) {
        ctx.ui.notify("Worker is already running a request.", "warning");
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(fs.readFileSync(requestPath, "utf8"));
      } catch (error) {
        ctx.ui.notify(`Could not read worker request: ${error instanceof Error ? error.message : String(error)}`, "error");
        return;
      }
      if (!isWorkerRequestFile(parsed)) {
        ctx.ui.notify("Invalid worker request file.", "error");
        return;
      }

      activeRequest = {
        request: parsed,
        priorTools: pi.getActiveTools(),
      };
      writeWorkerStatus(parsed.statusPath, {
        id: parsed.id,
        state: "running",
        resultPath: parsed.resultPath,
        sessionFile: ctx.sessionManager.getSessionFile() ?? undefined,
        contextPercent: getContextPercent(ctx) ?? null,
      });
      pi.sendUserMessage(parsed.task);
    },
  });

  pi.registerCommand(FINISH_CALL_NOW_COMMAND, {
    description: "Immediately finish the active worker with a message, bypassing retrospective. Usage: /finish-call-now \"message\"",
    handler: async (args, ctx) => {
      const message = parseFinishText(args);
      if (!message) {
        ctx.ui.notify("Usage: /finish-call-now \"message\"", "warning");
        return;
      }
      if (!ctx.isIdle()) {
        ctx.abort();
        await ctx.waitForIdle();
      } else {
        await ctx.waitForIdle();
      }
      if (!activeRequest) {
        ctx.ui.notify("No active worker request to finish.", "warning");
        return;
      }
      const request = activeRequest;
      completeWorkerRequest(ctx, request, message, false, "retrospective bypassed by /finish-call-now.");
      pi.setActiveTools(request.priorTools);
      ctx.ui.notify("Finished worker request with override result.", "info");
    },
  });

  pi.on("agent_end", async (event, ctx) => {
    if (!activeRequest || fs.existsSync(activeRequest.request.resultPath)) return;
    const message = latestAssistantMessage(event.messages);
    if (!message) return;

    if (activeRequest.mainResult !== undefined) {
      if (message.stopReason === "aborted" || message.stopReason === "toolUse") return;
      if (isRetryableAssistantFailure(message)) {
        const request = activeRequest;
        scheduleRetryableFailure(ctx, request, () => {
          const retrospective = `retrospective unavailable: assistant retry did not restart within ${Math.floor(RETRY_START_GRACE_MS / 1000)}s after retryable error. ${assistantMessageText(message)}`;
          completeWorkerRequest(ctx, request, request.mainResult ?? "", false, retrospective);
          pi.setActiveTools(request.priorTools);
        });
        return;
      }
      const retrospective = message.stopReason === "stop"
        ? (assistantTextContent(message) ?? "retrospective unavailable: assistant returned no retrospective text.")
        : `retrospective unavailable: assistant stopped with reason '${message.stopReason}'. ${assistantMessageText(message)}`;
      try {
        const request = activeRequest;
        completeWorkerRequest(ctx, request, request.mainResult ?? "", false, retrospective);
        pi.setActiveTools(request.priorTools);
        ctx.ui.notify("Finished worker request with result and retrospective.", "info");
      } catch (error) {
        ctx.ui.notify(`Failed to write worker retrospective result: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
      return;
    }

    if (message.stopReason === "stop") {
      const result = assistantTextContent(message);
      if (!result) {
        try {
          completeWorkerRequest(ctx, activeRequest, "Worker stopped without final result text.", true);
        } catch (error) {
          ctx.ui.notify(`Failed to report empty worker result: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
        return;
      }

      activeRequest.mainResult = result;
      writeTextArtifact(path.join(path.dirname(activeRequest.request.resultPath), "result.md"), result);
      writeWorkerStatus(activeRequest.request.statusPath, {
        id: activeRequest.request.id,
        state: "retrospective",
        resultPath: activeRequest.request.resultPath,
        sessionFile: ctx.sessionManager.getSessionFile() ?? undefined,
        contextPercent: getContextPercent(ctx) ?? null,
      });
      pi.setActiveTools([]);
      pi.sendUserMessage(RETROSPECTIVE_PROMPT, { deliverAs: "followUp" });
      return;
    }

    if (isRetryableAssistantFailure(message)) {
      const request = activeRequest;
      scheduleRetryableFailure(ctx, request, () => completeWorkerRequest(ctx, request, assistantMessageText(message), true));
      return;
    }

    if (message.stopReason === "aborted") return;

    try {
      completeWorkerRequest(ctx, activeRequest, assistantMessageText(message), true);
    } catch (error) {
      ctx.ui.notify(`Failed to write worker failure result: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  });

  pi.on("turn_end", async (_event, ctx) => {
    if (!activeRequest) return;
    writeWorkerStatus(activeRequest.request.statusPath, {
      id: activeRequest.request.id,
      state: activeRequest.mainResult === undefined ? "running" : "retrospective",
      resultPath: activeRequest.request.resultPath,
      sessionFile: ctx.sessionManager.getSessionFile() ?? undefined,
      contextPercent: getContextPercent(ctx) ?? null,
    });
  });

  pi.on("before_agent_start", async (event) => {
    if (!activeRequest) return undefined;
    if (activeRequest.mainResult !== undefined) {
      return { systemPrompt: `${event.systemPrompt}\n\nYou are in the retrospective phase of a worker request. The main result is already saved for the parent. Do not call tools and do not continue the original task. Answer only the retrospective prompt.` };
    }
    return { systemPrompt: `${event.systemPrompt}\n\nYou are running a structured worker request. When the task is complete, answer with only the exact result text for the caller, or the cause of failure. That final assistant message is returned to the parent.` };
  });
}
