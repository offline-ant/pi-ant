import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentEndEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isRetryableAssistantErrorMessage, RETRY_START_GRACE_MS } from "./retryable-errors.ts";
import { paneExists, readPane } from "./herdr-helpers.ts";

const WORKER_ROOT_PREFIX = "pi-herdr-worker-";
const WORKER_RUN_COMMAND = "worker-run";
const SUBMIT_WORKER_COMMAND = "worker-submit";
const FINISH_WORKER_NOW_COMMAND = "finish-worker-now";
const RESULT_POLL_INTERVAL_MS = 250;
const PROGRESS_UPDATE_INTERVAL_MS = 5000;
const PANE_STATE_POLL_INTERVAL_MS = 1000;
const PANE_MISSING_GRACE_MS = 5000;

const MAIN_RESULT_PROMPT_PREFIX =
  "Complete the worker task and return only the parent-facing result or blocker.";

const RETROSPECTIVE_PROMPT = [
  "The main result has already been saved for the parent. Do not repeat it, do not continue the task, and do not call tools.",
  "Return only substantial observations you noticed outside the task, or important details not included in the main result, that are worth preserving.",
  "If there is nothing substantial, return exactly: everything was ok",
].join("\n");

const SUPERVISION_CONTEXT =
  "A human is supervising this worker. Respond normally to their latest request. Replies remain in this worker until the human uses /worker-submit.";

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
  state: "idle" | "running" | "supervised" | "retrospective" | "error" | "closed";
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

type WorkerPhase = "result" | "retrospective";
type WorkerCapture = "automatic" | "supervised";

interface ActiveWorkerRequest {
  request: WorkerRequestFile;
  priorTools: string[];
  phase: WorkerPhase;
  capture: WorkerCapture;
  candidate?: string;
  mainResult?: string;
  submitting: boolean;
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
      && (entry.customType === "pi-herdr:delegate" || entry.customType === "pi-herdr:coding-agent" || entry.customType === "pi-herdr:fresh-history");
  });
}

function stripSubagentTools(tools: string[]): string[] {
  return tools.filter((tool) => tool !== "delegate" && tool !== "coding-agent" && tool !== "fresh-history");
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

function parseCommandText(args: string | undefined): string {
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

export function createWorkerArtifacts(): WorkerArtifactPaths {
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
  const usefulFiles = ["prompt.md", "result.md", "retrospective.md", "request.json", "result.json", "status.json"];
  return [`More info in ${paths.artifactDir}`, `Useful files: ${usefulFiles.join(", ")}`].join("\n");
}

export function appendWorkerMoreInfo(message: string, paths: WorkerArtifactPaths): string {
  const trimmed = message.trimEnd();
  if (!trimmed) return formatWorkerMoreInfo(paths);
  if (trimmed.includes(paths.artifactDir)) return trimmed;
  return `${trimmed}\n\n${formatWorkerMoreInfo(paths)}`;
}

export function formatWorkerResult(result: WorkerResultFile): string {
  if (result.retrospective === undefined) return result.result;
  return `${result.result.trimEnd()}\n\n---\n\nRetrospective:\n${result.retrospective}`;
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
  const machineMatch = text.match(/^PI_HERDR_PANE_ID=([^\s]+)$/m);
  if (machineMatch) return machineMatch[1];
  const statusMatch = text.match(/Started Herdr pane '([^']+)'/);
  if (statusMatch) return statusMatch[1];
  return requestedLockName;
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

export async function captureWorkerOutput(pi: ExtensionAPI, paneId: string, lines = 80, signal?: AbortSignal): Promise<string> {
  try {
    const text = await readPane(pi, paneId, lines, signal);
    return text || "(no Herdr output)";
  } catch (error) {
    throwIfAborted(signal);
    return `Could not capture Herdr output for ${paneId}: ${error instanceof Error ? error.message : String(error)}`;
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
  state: "live" | "missing";
  paneId?: string;
  text: string;
}

async function readWorkerPaneState(pi: ExtensionAPI, paneId: string, signal?: AbortSignal): Promise<WorkerPaneState> {
  try {
    if (await paneExists(pi, paneId, signal)) return { state: "live", paneId, text: "state=live" };
    return { state: "missing", paneId, text: "state=missing" };
  } catch (error) {
    throwIfAborted(signal);
    return { state: "missing", paneId, text: error instanceof Error ? error.message : String(error) };
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
      } else {
        paneMissingSince ??= Date.now();
        if (hasSeenLivePane || Date.now() - paneMissingSince >= PANE_MISSING_GRACE_MS) {
          throw new Error([
            "Worker pane disappeared before writing a final result.",
            `Herdr pane: ${lastKnownPaneId ?? options.actualLockName}`,
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
      const status = readWorkerStatus(options.paths.statusPath);
      const progress = status?.state === "supervised"
        ? `Worker ${options.actualLockName} is supervised and waiting for /worker-submit (${Math.floor(elapsedMs / 1000)}s elapsed).`
        : `Waiting for worker ${options.actualLockName} (${Math.floor(elapsedMs / 1000)}s elapsed).`;
      options.onUpdate({
        content: [{ type: "text", text: [progress, `Session: ${options.sessionFile}`, "", output].join("\n") }],
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
          status: status?.state ?? "waiting",
        },
      });
    }

    await delay(RESULT_POLL_INTERVAL_MS);
    throwIfAborted(options.signal);
  }
}

function writeFinalResult(
  ctx: ExtensionContext,
  active: ActiveWorkerRequest,
  result: string,
  isError = false,
  retrospective?: string,
): void {
  const contextPercent = getContextPercent(ctx);
  writeTextArtifact(path.join(path.dirname(active.request.resultPath), "result.md"), result);
  if (retrospective !== undefined) {
    writeTextArtifact(path.join(path.dirname(active.request.resultPath), "retrospective.md"), retrospective);
  }

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

  function refreshWorkerUi(ctx: ExtensionContext): void {
    const request = activeRequest;
    if (!request) {
      ctx.ui.setStatus("worker-frame", undefined);
      ctx.ui.setWidget("worker-frame", undefined);
      return;
    }

    if (request.capture === "supervised") {
      const phase = request.phase === "result" ? "result" : "retrospective";
      ctx.ui.setStatus("worker-frame", ctx.ui.theme.fg("warning", "worker:supervised"));
      ctx.ui.setWidget("worker-frame", [
        `Worker supervision (${phase})`,
        request.candidate ? "Latest assistant reply is ready to submit." : "Assistant replies stay in this worker.",
        "Use /worker-submit to send the latest reply to the parent.",
      ]);
      return;
    }

    const label = request.phase === "result" ? "worker:auto" : "worker:retrospective";
    ctx.ui.setStatus("worker-frame", ctx.ui.theme.fg("accent", label));
    ctx.ui.setWidget("worker-frame", undefined);
  }

  function writeActiveWorkerStatus(ctx: ExtensionContext, request: ActiveWorkerRequest): void {
    const state = request.capture === "supervised"
      ? "supervised"
      : request.phase === "result" ? "running" : "retrospective";
    writeWorkerStatus(request.request.statusPath, {
      id: request.request.id,
      state,
      resultPath: request.request.resultPath,
      sessionFile: ctx.sessionManager.getSessionFile() ?? undefined,
      contextPercent: getContextPercent(ctx) ?? null,
    });
  }

  function superviseWorker(ctx: ExtensionContext, request: ActiveWorkerRequest): void {
    if (request.capture === "supervised") return;
    clearRetryFailureTimer(request);
    request.capture = "supervised";
    if (request.phase === "retrospective") pi.setActiveTools(request.priorTools);
    writeActiveWorkerStatus(ctx, request);
    refreshWorkerUi(ctx);
    ctx.ui.notify("Worker is now supervised. Replies stay here until /worker-submit sends one to the parent.", "info");
  }

  function beginHumanInput(ctx: ExtensionContext, request: ActiveWorkerRequest): void {
    request.candidate = undefined;
    if (request.capture === "automatic") {
      superviseWorker(ctx, request);
      return;
    }
    writeActiveWorkerStatus(ctx, request);
    refreshWorkerUi(ctx);
  }

  function beginRetrospective(ctx: ExtensionContext, request: ActiveWorkerRequest, result: string): void {
    request.mainResult = result;
    request.phase = "retrospective";
    request.capture = "automatic";
    request.candidate = undefined;
    writeTextArtifact(path.join(path.dirname(request.request.resultPath), "result.md"), result);
    pi.setActiveTools([]);
    writeActiveWorkerStatus(ctx, request);
    refreshWorkerUi(ctx);
    pi.sendUserMessage(RETROSPECTIVE_PROMPT, { deliverAs: "followUp" });
  }

  function completeWorkerRequest(
    ctx: ExtensionContext,
    request: ActiveWorkerRequest,
    result: string,
    isError = false,
    retrospective?: string,
  ): void {
    clearRetryFailureTimer(request);
    writeFinalResult(ctx, request, result, isError, retrospective);
    const shouldClose = request.request.closeWhenDone;
    activeRequest = undefined;
    pi.setActiveTools(request.priorTools);
    refreshWorkerUi(ctx);
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
    refreshWorkerUi(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    refreshFreshWorkerTools(ctx);
    refreshWorkerUi(ctx);
  });

  pi.on("input", async (event, ctx) => {
    if (activeRequest && event.source !== "extension") {
      beginHumanInput(ctx, activeRequest);
    }
    return { action: "continue" };
  });

  pi.on("context", async (event) => {
    if (!activeRequest || activeRequest.capture !== "supervised") return undefined;
    const supervisionMessage: typeof event.messages[number] = {
      role: "custom",
      customType: "pi-herdr:supervision",
      content: SUPERVISION_CONTEXT,
      display: false,
      timestamp: Date.now(),
    };
    return { messages: [...event.messages, supervisionMessage] };
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
        phase: "result",
        capture: "automatic",
        submitting: false,
      };
      writeActiveWorkerStatus(ctx, activeRequest);
      refreshWorkerUi(ctx);
      pi.sendUserMessage(`${MAIN_RESULT_PROMPT_PREFIX}\n\n${parsed.task}`);
    },
  });

  pi.registerCommand(SUBMIT_WORKER_COMMAND, {
    description: "Submit the latest supervised assistant reply, or supplied text, to the parent. Usage: /worker-submit [message]",
    handler: async (args, ctx) => {
      const request = activeRequest;
      if (!request) {
        ctx.ui.notify("No active worker request to submit.", "warning");
        return;
      }
      if (request.submitting) {
        ctx.ui.notify("Worker submission is already waiting for the current turn.", "warning");
        return;
      }

      request.submitting = true;
      try {
        superviseWorker(ctx, request);
        await ctx.waitForIdle();
        if (activeRequest !== request || fs.existsSync(request.request.resultPath)) {
          ctx.ui.notify("Worker request is no longer active.", "warning");
          return;
        }

        const submitted = parseCommandText(args) || request.candidate;
        if (!submitted) {
          ctx.ui.notify("No assistant reply is ready. Wait for a reply or pass a message to /worker-submit.", "warning");
          return;
        }

        if (request.phase === "result") {
          beginRetrospective(ctx, request, submitted);
          ctx.ui.notify("Submitted worker result; running retrospective.", "info");
          return;
        }

        completeWorkerRequest(ctx, request, request.mainResult ?? "", false, submitted);
        ctx.ui.notify("Submitted worker retrospective.", "info");
      } finally {
        request.submitting = false;
      }
    },
  });

  pi.registerCommand(FINISH_WORKER_NOW_COMMAND, {
    description: "Immediately finish the active worker with a message, bypassing retrospective. Usage: /finish-worker-now \"message\"",
    handler: async (args, ctx) => {
      const message = parseCommandText(args);
      if (!message) {
        ctx.ui.notify("Usage: /finish-worker-now \"message\"", "warning");
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
      completeWorkerRequest(ctx, activeRequest, message, false, "retrospective bypassed by /finish-worker-now.");
      ctx.ui.notify("Finished worker request with override result.", "info");
    },
  });

  pi.on("agent_end", async (event, ctx) => {
    if (!activeRequest || fs.existsSync(activeRequest.request.resultPath)) return;
    const message = latestAssistantMessage(event.messages);
    if (!message) return;

    if (activeRequest.capture === "supervised") {
      if (message.stopReason !== "stop") return;
      const candidate = assistantTextContent(message);
      if (!candidate) return;
      activeRequest.candidate = candidate;
      writeActiveWorkerStatus(ctx, activeRequest);
      refreshWorkerUi(ctx);
      return;
    }

    if (activeRequest.phase === "retrospective") {
      if (message.stopReason === "aborted" || message.stopReason === "toolUse") return;
      if (isRetryableAssistantFailure(message)) {
        const request = activeRequest;
        scheduleRetryableFailure(ctx, request, () => {
          const retrospective = `retrospective unavailable: assistant retry did not restart within ${Math.floor(RETRY_START_GRACE_MS / 1000)}s after retryable error. ${assistantMessageText(message)}`;
          completeWorkerRequest(ctx, request, request.mainResult ?? "", false, retrospective);
        });
        return;
      }
      const retrospective = message.stopReason === "stop"
        ? (assistantTextContent(message) ?? "retrospective unavailable: assistant returned no retrospective text.")
        : `retrospective unavailable: assistant stopped with reason '${message.stopReason}'. ${assistantMessageText(message)}`;
      try {
        const request = activeRequest;
        completeWorkerRequest(ctx, request, request.mainResult ?? "", false, retrospective);
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

      beginRetrospective(ctx, activeRequest, result);
      return;
    }

    if (isRetryableAssistantFailure(message)) {
      const request = activeRequest;
      scheduleRetryableFailure(ctx, request, () => completeWorkerRequest(ctx, request, assistantMessageText(message), true));
      return;
    }

    if (message.stopReason === "aborted" || message.stopReason === "toolUse") return;

    try {
      completeWorkerRequest(ctx, activeRequest, assistantMessageText(message), true);
    } catch (error) {
      ctx.ui.notify(`Failed to write worker failure result: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  });

  pi.on("turn_end", async (_event, ctx) => {
    if (!activeRequest) return;
    writeActiveWorkerStatus(ctx, activeRequest);
  });
}
