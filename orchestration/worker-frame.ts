import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isContextOverflow, isRetryableAssistantError } from "@earendil-works/pi-ai";
import type { AgentEndEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { initializeNesting } from "./nesting.ts";

const WORKER_ROOT_PREFIX = "pi-orchestration-worker-";
const WORKER_RUN_COMMAND = "worker-run";
const CONTINUE_WORKER_COMMAND = "worker-continue";
const SUBMIT_WORKER_COMMAND = "worker-submit";
const FINISH_WORKER_NOW_COMMAND = "finish-worker-now";
const SUBWORKER_TOOLS = new Set(["delegate", "coding-agent", "fresh-history"]);
const FIRST_ACTION_SUBWORKER_WARNING =
  "This is an automated warning heuristic. You are in a worker frame. Do not simply forward the entire task; investigate it and/or split it into a distinct subtask. Continue working, and retry the worker call if this warning was triggered in error.";

const MAIN_RESULT_PROMPT_PREFIX =
  "Complete the worker task and return only the parent-facing result or blocker.";

const RETROSPECTIVE_PROMPT = [
  "The main result has already been saved for the parent. Do not repeat it, do not continue the task, and do not call tools.",
  "Return only substantial observations you noticed outside the task, or important details not included in the main result, that are worth preserving.",
  "If there is nothing substantial, return exactly: everything was ok",
].join("\n");

const SUPERVISION_CONTEXT =
  "A human is supervising this worker. Respond normally to their latest request. Replies remain in this worker until the human uses /worker-submit, or /worker-continue to resume automatic completion.";

export interface WorkerRequestFile {
  id: string;
  task: string;
  tools: string[];
  model: { provider: string; id: string };
  thinkingLevel: NonNullable<ExtensionContext["thinkingLevel"]>;
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
  supervisionReason?: string;
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

interface PendingWorkerFailure {
  message: string;
  resolution: "error" | "supervise";
}

interface ActiveWorkerRequest {
  request: WorkerRequestFile;
  workerTools: string[];
  hasTakenToolAction: boolean;
  phase: WorkerPhase;
  capture: WorkerCapture;
  candidate?: string;
  mainResult?: string;
  pendingContinuePrompt?: string;
  pendingFailure?: PendingWorkerFailure;
  supervisionReason?: string;
  submitting: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isWorkerRequestFile(value: unknown): value is WorkerRequestFile {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.task === "string"
    && Array.isArray(value.tools)
    && value.tools.every((tool) => typeof tool === "string")
    && isRecord(value.model)
    && typeof value.model.provider === "string"
    && typeof value.model.id === "string"
    && typeof value.thinkingLevel === "string"
    && ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value.thinkingLevel)
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

  function availableWorkerTools(requestedTools: string[]): string[] {
    const available = new Set(pi.getAllTools().map((tool) => tool.name));
    return [...new Set(requestedTools)].filter((tool) => available.has(tool));
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
        request.supervisionReason ?? (request.candidate ? "Latest assistant reply is ready to submit." : "Assistant replies stay in this worker."),
        request.candidate
          ? "Use /worker-submit to send the latest reply to the parent."
          : "Type a message to retry or investigate; use /worker-submit when a reply is ready.",
        "Use /worker-continue <prompt> to give guidance and resume automatic completion.",
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
      supervisionReason: request.supervisionReason,
    });
  }

  function superviseWorker(ctx: ExtensionContext, request: ActiveWorkerRequest, reason?: string): void {
    const wasSupervised = request.capture === "supervised";
    request.capture = "supervised";
    if (reason !== undefined || !wasSupervised) request.supervisionReason = reason;
    if (request.phase === "retrospective") pi.setActiveTools(request.workerTools);
    writeActiveWorkerStatus(ctx, request);
    refreshWorkerUi(ctx);
    if (!wasSupervised || reason !== undefined) {
      ctx.ui.notify(
        reason
          ? `${reason} The worker is now supervised; type a message to investigate, then use /worker-submit or /worker-continue <prompt>.`
          : "Worker is now supervised. Use /worker-submit to return a reply or /worker-continue <prompt> to resume automatic completion.",
        reason ? "warning" : "info",
      );
    }
  }

  function beginHumanInput(ctx: ExtensionContext, request: ActiveWorkerRequest): void {
    request.candidate = undefined;
    request.pendingContinuePrompt = undefined;
    request.pendingFailure = undefined;
    request.supervisionReason = undefined;
    if (request.capture === "automatic") {
      superviseWorker(ctx, request);
      return;
    }
    writeActiveWorkerStatus(ctx, request);
    refreshWorkerUi(ctx);
  }

  function resumeAutomaticCapture(ctx: ExtensionContext, request: ActiveWorkerRequest, prompt: string): void {
    request.capture = "automatic";
    request.candidate = undefined;
    request.pendingContinuePrompt = prompt;
    request.pendingFailure = undefined;
    request.supervisionReason = undefined;
    if (request.phase === "retrospective") pi.setActiveTools([]);
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
    writeFinalResult(ctx, request, result, isError, retrospective);
    const shouldClose = request.request.closeWhenDone;
    activeRequest = undefined;
    pi.setActiveTools(request.workerTools);
    refreshWorkerUi(ctx);
    if (shouldClose) ctx.shutdown();
  }

  pi.on("session_start", async (_event, ctx) => {
    initializeNesting();
    refreshWorkerUi(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    refreshWorkerUi(ctx);
  });

  pi.on("input", async (event, ctx) => {
    if (activeRequest && event.source !== "extension") {
      beginHumanInput(ctx, activeRequest);
    }
    return { action: "continue" };
  });

  pi.on("tool_call", async (event) => {
    const request = activeRequest;
    if (!request || request.phase !== "result") return undefined;

    const isFirstToolAction = !request.hasTakenToolAction;
    request.hasTakenToolAction = true;
    if (isFirstToolAction && SUBWORKER_TOOLS.has(event.toolName)) {
      return { block: true, reason: FIRST_ACTION_SUBWORKER_WARNING };
    }
    return undefined;
  });

  pi.on("context", async (event) => {
    if (!activeRequest || activeRequest.capture !== "supervised") return undefined;
    const supervisionMessage: typeof event.messages[number] = {
      role: "custom",
      customType: "pi-orchestration:supervision",
      content: SUPERVISION_CONTEXT,
      display: false,
      timestamp: Date.now(),
    };
    return { messages: [...event.messages, supervisionMessage] };
  });

  pi.on("message_start", async (event) => {
    const request = activeRequest;
    if (!request?.pendingContinuePrompt || event.message.role !== "user") return;
    const content = event.message.content;
    const text = typeof content === "string"
      ? content
      : content.filter((item) => item.type === "text").map((item) => item.text).join("");
    if (text === request.pendingContinuePrompt) {
      request.pendingContinuePrompt = undefined;
      request.pendingFailure = undefined;
    }
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

      if (fs.existsSync(parsed.resultPath)) {
        ctx.ui.notify("This worker request already has a final result.", "warning");
        return;
      }
      const workerTools = availableWorkerTools(parsed.tools);
      activeRequest = {
        request: parsed,
        workerTools,
        hasTakenToolAction: false,
        phase: "result",
        capture: "automatic",
        submitting: false,
      };
      const request = activeRequest;
      try {
        const model = ctx.modelRegistry.find(parsed.model.provider, parsed.model.id);
        if (!model || !(await pi.setModel(model))) {
          throw new Error(`Worker model unavailable: ${parsed.model.provider}/${parsed.model.id}`);
        }
        if (activeRequest !== request) return;
        pi.setThinkingLevel(parsed.thinkingLevel);
        pi.setActiveTools(workerTools);
        writeActiveWorkerStatus(ctx, request);
        refreshWorkerUi(ctx);
        pi.sendUserMessage(`${MAIN_RESULT_PROMPT_PREFIX}\n\n${parsed.task}`);
      } catch (error) {
        if (activeRequest !== request) return;
        const message = `Could not start worker request: ${error instanceof Error ? error.message : String(error)}`;
        completeWorkerRequest(ctx, request, message, true);
        ctx.ui.notify(message, "error");
      }
    },
  });

  pi.registerCommand(CONTINUE_WORKER_COMMAND, {
    description: "Send guidance and resume automatic worker completion. Usage: /worker-continue <prompt>",
    handler: async (args, ctx) => {
      const request = activeRequest;
      if (!request) {
        ctx.ui.notify("No active worker request to continue.", "warning");
        return;
      }
      if (request.submitting) {
        ctx.ui.notify("Worker submission is already waiting for the current turn.", "warning");
        return;
      }

      const prompt = parseCommandText(args);
      if (!prompt) {
        ctx.ui.notify("Usage: /worker-continue <prompt>", "warning");
        return;
      }

      resumeAutomaticCapture(ctx, request, prompt);
      pi.sendUserMessage(prompt, { deliverAs: "steer" });
      ctx.ui.notify(
        request.phase === "result"
          ? "Guidance sent; worker will complete automatically."
          : "Guidance sent; worker retrospective will complete automatically.",
        "info",
      );
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
      if (request.pendingContinuePrompt !== undefined) {
        ctx.ui.notify("Worker guidance is queued. Wait for the continued reply before using /worker-submit.", "warning");
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
      const request = activeRequest;
      if (!request) {
        ctx.ui.notify("No active worker request to finish.", "warning");
        return;
      }
      // Hold automatic completion while abort/settlement events drain.
      superviseWorker(ctx, request);
      if (!ctx.isIdle()) await ctx.abort();
      await ctx.waitForIdle();
      if (activeRequest !== request) return;
      completeWorkerRequest(ctx, request, request.mainResult ?? message, false,
        request.mainResult === undefined ? "retrospective bypassed by /finish-worker-now." : message);
      ctx.ui.notify("Finished worker request with override result.", "info");
    },
  });

  pi.on("agent_end", async (event, ctx) => {
    if (!activeRequest || fs.existsSync(activeRequest.request.resultPath)) return;
    const message = latestAssistantMessage(event.messages);
    // Terminating tool batches can end a run without final assistant text.
    // Wait for Pi settlement before treating that as a recoverable failure.
    if (!message || message.stopReason === "toolUse") {
      activeRequest.pendingFailure = {
        message: message ? "Worker stopped after a tool batch without final result text." : "Worker stopped without an assistant message.",
        resolution: "supervise",
      };
      return;
    }

    if (message.stopReason === "error") {
      const retryable = !isContextOverflow(message, ctx.model?.contextWindow) && isRetryableAssistantError(message);
      activeRequest.pendingFailure = {
        message: assistantMessageText(message),
        resolution: retryable ? "supervise" : "error",
      };
      return;
    }
    if (message.stopReason === "aborted") {
      activeRequest.pendingFailure = {
        message: assistantMessageText(message),
        resolution: "supervise",
      };
      return;
    }
    activeRequest.pendingFailure = undefined;

    if (activeRequest.capture === "automatic" && activeRequest.pendingContinuePrompt !== undefined) {
      return;
    }

    if (activeRequest.capture === "supervised") {
      if (message.stopReason !== "stop") return;
      const candidate = assistantTextContent(message);
      if (!candidate) return;
      activeRequest.candidate = candidate;
      activeRequest.supervisionReason = undefined;
      writeActiveWorkerStatus(ctx, activeRequest);
      refreshWorkerUi(ctx);
      return;
    }

    if (activeRequest.phase === "retrospective") {
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

    try {
      completeWorkerRequest(ctx, activeRequest, assistantMessageText(message), true);
    } catch (error) {
      ctx.ui.notify(`Failed to write worker failure result: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const request = activeRequest;
    if (!request?.pendingFailure || fs.existsSync(request.request.resultPath)) return;
    if (request.pendingContinuePrompt !== undefined) return;

    const failure = request.pendingFailure;
    request.pendingFailure = undefined;
    if (request.capture === "supervised") {
      request.supervisionReason = `Automatic worker run ended without a result: ${failure.message}`;
      writeActiveWorkerStatus(ctx, request);
      refreshWorkerUi(ctx);
      return;
    }

    if (request.phase === "retrospective") {
      try {
        completeWorkerRequest(
          ctx,
          request,
          request.mainResult ?? "",
          false,
          `retrospective unavailable: automatic worker run ended without a result. ${failure.message}`,
        );
      } catch (error) {
        ctx.ui.notify(`Failed to report unavailable worker retrospective: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
      return;
    }

    if (failure.resolution === "error") {
      try {
        completeWorkerRequest(ctx, request, failure.message, true);
      } catch (error) {
        ctx.ui.notify(`Failed to report worker failure: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
      return;
    }

    superviseWorker(ctx, request, `Automatic worker run ended without a result: ${failure.message}`);
  });

  pi.on("turn_end", async (_event, ctx) => {
    if (!activeRequest) return;
    writeActiveWorkerStatus(ctx, activeRequest);
  });
}
