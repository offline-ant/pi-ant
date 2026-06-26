import * as fs from "node:fs";
import * as path from "node:path";
import { SessionManager, type AgentEndEvent, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { flushSessionFile, runTmux, writePromptFile } from "./tmux-helpers.ts";
import { getToolModelCliArgs } from "./tool-model-state.ts";

const CALL_TOOL = "call";
const ASK_TOOL = "ask";
const MINITASK_TOOL = "minitask";
const REMOVED_CALL_CONTROL_TOOLS = new Set(["finish_call", "return"]);
const ROOT_STATE_CUSTOM_TYPE = "pi-ant:call-state";
const CALL_RUNTIME_CUSTOM_TYPE = "pi-ant:call-runtime";
const RETROSPECTIVE_PENDING_CUSTOM_TYPE = "pi-ant:call-retrospective-pending";
const FINISH_CALL_NOW_COMMAND = "finish-call-now";
const RESULT_POLL_INTERVAL_MS = 250;
const PROGRESS_UPDATE_INTERVAL_MS = 5000;
const UNFINISHED_CALL_ERROR_QUIET_PERIOD_MS = 30_000;
const UNFINISHED_CALL_ERROR_RECHECK_MS = 5_000;
const LOCK_DIR = "/tmp/pi-semaphores";
const DESIGN_PRINCIPLES_PROMPT = [
  "Note our design principles: Do the hard part first, clean up as you go, leave no dead code or overcomplicated abstractions behind,",
  "being broken between phases is fine, cost of change is 0, avoid quick fixes / hacks, the well-designed long-term architecture end state is critical.",
  "Clear, consistent names are important; immediately refactor and rename things to best describe reality.",
].join(" ");
const RETROSPECTIVE_PROMPT = [
  "The main call result has already been saved for the parent. Do not repeat it, do not continue the task, and do not call tools.",
  "Return only substantial observations you noticed outside of the given task, or substantial things you did not mention regarding it, that are worth taking into account or fixing in the long run.",
  "Design principles to apply: do the hard part first; clean up as you go; leave no dead code or overcomplicated abstractions behind; being broken between phases is fine; cost of change is zero; avoid quick fixes and hacks; the well-designed long-term architecture end state is critical; clear, consistent names are important; immediately refactor and rename things to best describe reality.",
  "If there is nothing substantial, return exactly: everything was ok",
].join("\n");

const callParams = Type.Object({
  task: Type.String({
    minLength: 1,
    description: "Task to complete in a forked tmux call frame using the current conversation context.",
  }),
  complex: Type.Optional(
    Type.Boolean({
      description: "Allow this call frame to use call for substantial delegated subtasks.",
    }),
  ),
  retrospective: Type.Optional(
    Type.Boolean({
      description:
        "After the main result is ready, ask the call frame for no-tools long-term observations and append them to the result. Choose true mainly when the call is likely to read or inspect more than about 5 files, perform a deep code dive, or uncover design/naming/architecture cleanup opportunities; choose false for small, narrow, or mechanical tasks.",
    }),
  ),
});

type CallParams = Static<typeof callParams>;

interface RootCallState {
  bobsMode: boolean;
  rootTools: string[];
}

interface CallRuntimeState {
  id: string;
  task: string;
  complex: boolean;
  retrospective: boolean;
  resultPath: string;
  parentSession: string;
  childSession: string;
  parentCwd: string;
  childCwd: string;
  lockName: string;
  workerTools: string[];
  createdAt: string;
}

interface RetrospectivePendingState {
  id: string;
  result: string;
  requestedAt: string;
}

interface DeferredCallFinalization {
  runtimeId: string;
  timer: ReturnType<typeof setTimeout>;
  finalize: () => void;
}

interface CustomStateEntryLike {
  type: string;
  customType?: string;
  data?: unknown;
}

interface CallResultFile {
  id: string;
  result: string;
  timestamp: string;
  sessionFile?: string;
  isError?: boolean;
}

interface CallToolDetails {
  id: string;
  lockName: string;
  requestedLockName: string;
  resultPath: string;
  artifactDir: string;
  promptPath: string;
  resultMarkdownPath: string;
  reflectMarkdownPath?: string;
  childSessionFile: string;
  task: string;
  complex: boolean;
  retrospective: boolean;
  elapsedMs?: number;
  status?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.every((item) => typeof item === "string") ? value : undefined;
}

function getCustomStateEntries(ctx: ExtensionContext): CustomStateEntryLike[] {
  const entries: CustomStateEntryLike[] = [];
  for (const entry of ctx.sessionManager.getBranch()) {
    if (!isRecord(entry) || typeof entry.type !== "string" || typeof entry.customType !== "string") continue;
    entries.push({ type: entry.type, customType: entry.customType, data: entry.data });
  }
  return entries;
}

function parseRootCallState(value: unknown): RootCallState | undefined {
  if (!isRecord(value)) return undefined;
  const bobsMode = value.bobsMode;
  const rootTools = stringArray(value.rootTools);
  if (typeof bobsMode !== "boolean" || rootTools === undefined) return undefined;
  return { bobsMode, rootTools: stripControlTools(rootTools) };
}

function getLatestRootState(ctx: ExtensionContext): RootCallState | undefined {
  const entries = getCustomStateEntries(ctx);
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.customType !== ROOT_STATE_CUSTOM_TYPE) continue;
    const state = parseRootCallState(entry.data);
    if (state) return state;
  }
  return undefined;
}

function parseCallRuntime(value: unknown): CallRuntimeState | undefined {
  if (!isRecord(value)) return undefined;
  const workerTools = stringArray(value.workerTools);
  if (
    typeof value.id !== "string" ||
    typeof value.task !== "string" ||
    typeof value.complex !== "boolean" ||
    typeof value.resultPath !== "string" ||
    typeof value.parentSession !== "string" ||
    typeof value.childSession !== "string" ||
    typeof value.parentCwd !== "string" ||
    typeof value.childCwd !== "string" ||
    typeof value.lockName !== "string" ||
    workerTools === undefined ||
    typeof value.createdAt !== "string"
  ) {
    return undefined;
  }

  return {
    id: value.id,
    task: value.task,
    complex: value.complex,
    retrospective: value.retrospective === true,
    resultPath: value.resultPath,
    parentSession: value.parentSession,
    childSession: value.childSession,
    parentCwd: value.parentCwd,
    childCwd: value.childCwd,
    lockName: value.lockName,
    workerTools: stripControlTools(workerTools),
    createdAt: value.createdAt,
  };
}

function getLatestCallRuntime(ctx: ExtensionContext): CallRuntimeState | undefined {
  const entries = getCustomStateEntries(ctx);
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.customType !== CALL_RUNTIME_CUSTOM_TYPE) continue;
    const runtime = parseCallRuntime(entry.data);
    if (runtime) return runtime;
  }
  return undefined;
}

function parseRetrospectivePending(value: unknown): RetrospectivePendingState | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.result !== "string" || typeof value.requestedAt !== "string") {
    return undefined;
  }
  return { id: value.id, result: value.result, requestedAt: value.requestedAt };
}

function getLatestRetrospectivePending(ctx: ExtensionContext, runtime: CallRuntimeState): RetrospectivePendingState | undefined {
  const entries = getCustomStateEntries(ctx);
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.customType !== RETROSPECTIVE_PENDING_CUSTOM_TYPE) continue;
    const pending = parseRetrospectivePending(entry.data);
    if (pending?.id === runtime.id) return pending;
  }
  return undefined;
}

function defaultRootState(activeTools: string[]): RootCallState {
  return { bobsMode: false, rootTools: stripControlTools(activeTools) };
}

function stripControlTools(tools: string[]): string[] {
  return tools.filter((tool) => tool !== CALL_TOOL && !REMOVED_CALL_CONTROL_TOOLS.has(tool));
}

function uniqueTools(tools: string[]): string[] {
  return [...new Set(tools)];
}

function rootActiveTools(state: RootCallState): string[] {
  if (state.bobsMode) return [CALL_TOOL, ASK_TOOL, MINITASK_TOOL];
  return uniqueTools([...state.rootTools, CALL_TOOL]);
}

function runtimeActiveTools(runtime: CallRuntimeState): string[] {
  return uniqueTools([...runtime.workerTools, ...(runtime.complex ? [CALL_TOOL] : [])]);
}

function parseFinishCallNowText(args: string | undefined): string {
  const trimmed = (args ?? "").trim();
  if (trimmed.length < 2) return trimmed;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function renderCallArgs(args: CallParams) {
  const payload = JSON.stringify(args, null, 2) ?? String(args);
  const lines = ["call(", ...payload.split("\n").map((line) => `  ${line}`), ")"];
  return {
    render: (contentWidth: number) => lines.flatMap((line) => wrapTextWithAnsi(line, contentWidth)),
    invalidate: () => {
      /* no-op */
    },
  };
}

function callFrameInstructions(task: string, includeDesignPrinciples: boolean): string {
  return [
    "You have stepped inside a call frame. Use the available tools to complete the task below. When the task is complete, answer with only the exact result text for the caller, or the cause of failure. That final assistant message is returned to the parent call frame.",
    ...(includeDesignPrinciples ? ["", DESIGN_PRINCIPLES_PROMPT] : []),
    "",
    "Task:",
    task,
  ].join("\n");
}

function statusText(rootState: RootCallState | undefined, runtime: CallRuntimeState | undefined): string | undefined {
  if (runtime) return `call:child${runtime.complex ? ":complex" : ""}`;
  if (!rootState) return undefined;
  return rootState.bobsMode ? "bobs:on" : undefined;
}

function isTmuxAvailable(): boolean {
  return !!process.env.TMUX;
}

function makeCallId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function sanitizeLockName(name: string): string {
  return name.replace(/[^A-Za-z0-9._:-]/g, "");
}

function activeLockPath(name: string): string {
  return path.join(LOCK_DIR, name);
}

function isLockActive(name: string): boolean {
  return fs.existsSync(activeLockPath(name));
}

function isLockFinished(name: string): boolean {
  return !fs.existsSync(activeLockPath(name));
}

interface CallArtifactPaths {
  artifactDir: string;
  promptPath: string;
  resultPath: string;
  resultMarkdownPath: string;
  reflectMarkdownPath: string;
}

function callArtifactPathsFromResultPath(resultPath: string): CallArtifactPaths {
  const artifactDir = path.dirname(resultPath);
  return {
    artifactDir,
    promptPath: path.join(artifactDir, "prompt.md"),
    resultPath,
    resultMarkdownPath: path.join(artifactDir, "result.md"),
    reflectMarkdownPath: path.join(artifactDir, "reflect.md"),
  };
}

function callDetailsArtifactFields(
  resultPath: string,
  retrospective: boolean,
): Pick<CallToolDetails, "artifactDir" | "promptPath" | "resultMarkdownPath" | "reflectMarkdownPath"> {
  const paths = callArtifactPathsFromResultPath(resultPath);
  return {
    artifactDir: paths.artifactDir,
    promptPath: paths.promptPath,
    resultMarkdownPath: paths.resultMarkdownPath,
    ...(retrospective ? { reflectMarkdownPath: paths.reflectMarkdownPath } : {}),
  };
}

function createCallArtifacts(callId: string, prompt: string): CallArtifactPaths {
  const promptPath = writePromptFile(prompt, `pi-ant-call-${callId}-`);
  return callArtifactPathsFromResultPath(path.join(path.dirname(promptPath), "result.json"));
}

function writeTextArtifact(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, content, { encoding: "utf8", mode: 0o600 });
}

function parseCallResult(raw: string, resultPath: string, expectedId: string): CallResultFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const preview = raw.length > 2000 ? `${raw.slice(0, 2000)}\n[truncated]` : raw;
    throw new Error(`Invalid call result JSON at ${resultPath}: ${error instanceof Error ? error.message : String(error)}\n${preview}`);
  }

  if (!isRecord(parsed) || typeof parsed.id !== "string" || typeof parsed.result !== "string" || typeof parsed.timestamp !== "string") {
    throw new Error(`Invalid call result shape at ${resultPath}`);
  }
  if (parsed.id !== expectedId) {
    throw new Error(`Call result id mismatch at ${resultPath}: expected ${expectedId}, got ${parsed.id}`);
  }

  return {
    id: parsed.id,
    result: parsed.result,
    timestamp: parsed.timestamp,
    sessionFile: typeof parsed.sessionFile === "string" ? parsed.sessionFile : undefined,
    isError: typeof parsed.isError === "boolean" ? parsed.isError : undefined,
  };
}

function writeCallResult(
  runtime: CallRuntimeState,
  result: string,
  sessionFile: string | undefined,
  isError = false,
  artifacts?: { resultMarkdown?: string; reflectMarkdown?: string },
): void {
  fs.mkdirSync(path.dirname(runtime.resultPath), { recursive: true, mode: 0o700 });
  const artifactPaths = callArtifactPathsFromResultPath(runtime.resultPath);
  writeTextArtifact(artifactPaths.resultMarkdownPath, artifacts?.resultMarkdown ?? result);
  if (artifacts?.reflectMarkdown !== undefined) {
    writeTextArtifact(artifactPaths.reflectMarkdownPath, artifacts.reflectMarkdown);
  }

  const tmp = `${runtime.resultPath}.${process.pid}.${Date.now()}.tmp`;
  const payload: CallResultFile = {
    id: runtime.id,
    result,
    timestamp: new Date().toISOString(),
    sessionFile,
    isError,
  };

  fs.writeFileSync(tmp, `${JSON.stringify(payload)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try {
    fs.linkSync(tmp, runtime.resultPath);
  } catch (error) {
    if (isRecord(error) && error.code === "EEXIST") {
      throw new Error(`Call result already exists; duplicate final result refused: ${runtime.resultPath}`);
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function parseActualLockName(text: string, requestedLockName: string): string {
  const machineMatch = text.match(/^PI_TMUX_LOCK_NAME=([^\s]+)$/m);
  if (machineMatch) return machineMatch[1];
  const statusMatch = text.match(/Started tmux fork '([^']+)'/);
  if (statusMatch) return statusMatch[1];
  return requestedLockName;
}

function getPreCallLeafId(ctx: ExtensionContext, toolCallId: string): string | null {
  const leaf = ctx.sessionManager.getLeafEntry();
  if (!leaf) return null;
  if (leaf.type !== "message" || leaf.message.role !== "assistant") return ctx.sessionManager.getLeafId();

  const hasThisCall = leaf.message.content.some(
    (item) => isRecord(item) && item.type === "toolCall" && item.id === toolCallId && item.name === CALL_TOOL,
  );
  if (hasThisCall) return leaf.parentId ?? null;

  const hasAnyCallTool = leaf.message.content.some(
    (item) => isRecord(item) && item.type === "toolCall" && item.name === CALL_TOOL,
  );
  if (hasAnyCallTool) {
    throw new Error("Could not identify this call tool in the current assistant message; refusing to fork an unmatched tool-call transcript.");
  }

  return leaf.id;
}

function captureWorkerTools(pi: ExtensionAPI, rootState: RootCallState, runtime: CallRuntimeState | undefined): string[] {
  if (runtime) return stripControlTools(runtime.workerTools);
  if (rootState.bobsMode) return stripControlTools(rootState.rootTools);
  return stripControlTools(pi.getActiveTools());
}

async function captureTmuxOutput(pi: ExtensionAPI, lockName: string, lines = 80): Promise<string> {
  try {
    const result = await runTmux(pi, ["capture", lockName, String(lines)]);
    const text = result.stdout.trimEnd() || result.stderr.trimEnd();
    return text || "(no tmux output)";
  } catch (error) {
    return `Could not capture tmux output for ${lockName}: ${error instanceof Error ? error.message : String(error)}`;
  }
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
  if (text) return text;
  return undefined;
}

function assistantMessageText(message: Extract<AgentEndEvent["messages"][number], { role: "assistant" }>): string {
  return assistantTextContent(message) ?? message.errorMessage ?? `Assistant stopped with reason '${message.stopReason}' before returning a final call result.`;
}

function appendRetrospective(result: string, retrospective: string): string {
  return [result.trimEnd(), "", "---", "", "Call-frame retrospective:", retrospective.trim()].join("\n");
}

function callFrameFailure(message: Extract<AgentEndEvent["messages"][number], { role: "assistant" }>): string | undefined {
  if (message.stopReason === "aborted") return undefined;
  return assistantMessageText(message);
}

async function waitForCallResult(
  pi: ExtensionAPI,
  options: {
    id: string;
    actualLockName: string;
    requestedLockName: string;
    resultPath: string;
    childSessionFile: string;
    task: string;
    complex: boolean;
    retrospective: boolean;
    onUpdate?: (partial: { content: Array<{ type: "text"; text: string }>; details: CallToolDetails }) => void;
  },
): Promise<CallResultFile> {
  const startedAt = Date.now();
  let lastProgressAt = 0;

  while (true) {
    if (fs.existsSync(options.resultPath)) {
      return parseCallResult(fs.readFileSync(options.resultPath, "utf8"), options.resultPath, options.id);
    }

    const elapsedMs = Date.now() - startedAt;
    if (isLockFinished(options.actualLockName)) {
      if (fs.existsSync(options.resultPath)) {
        return parseCallResult(fs.readFileSync(options.resultPath, "utf8"), options.resultPath, options.id);
      }
      const output = await captureTmuxOutput(pi, options.actualLockName);
      throw new Error(
        [
          "Call frame exited before writing a final result.",
          `tmux lock: ${options.actualLockName}`,
          `child session: ${options.childSessionFile}`,
          `result path: ${options.resultPath}`,
          "",
          "Last tmux output:",
          output,
        ].join("\n"),
      );
    }

    if (options.onUpdate && elapsedMs - lastProgressAt >= PROGRESS_UPDATE_INTERVAL_MS) {
      lastProgressAt = elapsedMs;
      const output = await captureTmuxOutput(pi, options.actualLockName, 12);
      options.onUpdate({
        content: [
          {
            type: "text",
            text: [
              `Waiting for call frame ${options.actualLockName} (${Math.floor(elapsedMs / 1000)}s elapsed).`,
              `Child session: ${options.childSessionFile}`,
              "",
              output,
            ].join("\n"),
          },
        ],
        details: {
          id: options.id,
          lockName: options.actualLockName,
          requestedLockName: options.requestedLockName,
          resultPath: options.resultPath,
          ...callDetailsArtifactFields(options.resultPath, options.retrospective),
          childSessionFile: options.childSessionFile,
          task: options.task,
          complex: options.complex,
          retrospective: options.retrospective,
          elapsedMs,
          status: "waiting",
        },
      });
    }

    await delay(RESULT_POLL_INTERVAL_MS);
  }
}

export default function (pi: ExtensionAPI) {
  let currentRootState: RootCallState | undefined;
  let currentRuntime: CallRuntimeState | undefined;
  let deferredCallFinalization: DeferredCallFinalization | undefined;

  function resolveRootState(ctx: ExtensionContext): RootCallState | undefined {
    const persisted = getLatestRootState(ctx);
    currentRootState = persisted ?? currentRootState;
    return currentRootState;
  }

  function resolveRuntime(ctx: ExtensionContext): CallRuntimeState | undefined {
    const runtime = getLatestCallRuntime(ctx);
    currentRuntime = runtime;
    return runtime;
  }

  function appendRootState(state: RootCallState): void {
    currentRootState = state;
    pi.appendEntry(ROOT_STATE_CUSTOM_TYPE, state);
  }

  function applyTools(rootState: RootCallState | undefined, runtime: CallRuntimeState | undefined, retrospectivePending: boolean): void {
    if (runtime) {
      pi.setActiveTools(retrospectivePending ? [] : runtimeActiveTools(runtime));
      return;
    }
    pi.setActiveTools(rootActiveTools(rootState ?? defaultRootState(pi.getActiveTools())));
  }

  function clearDeferredCallFinalization(runtime?: CallRuntimeState): void {
    if (!deferredCallFinalization) return;
    if (runtime && deferredCallFinalization.runtimeId !== runtime.id) return;
    clearTimeout(deferredCallFinalization.timer);
    deferredCallFinalization = undefined;
  }

  function scheduleDeferredCallFinalization(ctx: ExtensionContext, runtime: CallRuntimeState, finalize: () => void): void {
    clearDeferredCallFinalization(runtime);

    const deferred: DeferredCallFinalization = {
      runtimeId: runtime.id,
      timer: setTimeout(check, UNFINISHED_CALL_ERROR_QUIET_PERIOD_MS),
      finalize,
    };
    deferredCallFinalization = deferred;

    function check(): void {
      if (deferredCallFinalization !== deferred) return;
      if (fs.existsSync(runtime.resultPath)) {
        clearDeferredCallFinalization(runtime);
        return;
      }

      const activeRuntime = resolveRuntime(ctx);
      if (!activeRuntime || activeRuntime.id !== runtime.id) {
        clearDeferredCallFinalization(runtime);
        return;
      }

      if (!ctx.isIdle() || ctx.hasPendingMessages()) {
        deferred.timer = setTimeout(check, UNFINISHED_CALL_ERROR_RECHECK_MS);
        return;
      }

      try {
        deferred.finalize();
        clearDeferredCallFinalization(runtime);
      } catch (error) {
        if (fs.existsSync(runtime.resultPath)) {
          clearDeferredCallFinalization(runtime);
          return;
        }
        const reason = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Failed to finalize deferred call error: ${reason}`, "error");
      }
    }
  }

  function updateUi(
    ctx: ExtensionContext,
    rootState: RootCallState | undefined,
    runtime: CallRuntimeState | undefined,
    retrospectivePending: boolean,
  ): void {
    const status = statusText(rootState, runtime);
    ctx.ui.setStatus("call", status ? ctx.ui.theme.fg("accent", retrospectivePending ? `${status}:retrospective` : status) : undefined);

    if (runtime) {
      ctx.ui.setWidget("call", [
        `tmux call frame${runtime.complex ? " (complex)" : ""}${runtime.retrospective ? " (retrospective)" : ""}`,
        `task: ${runtime.task.slice(0, 160)}${runtime.task.length > 160 ? "…" : ""}`,
        `artifacts: ${path.dirname(runtime.resultPath)}`,
        ...(retrospectivePending ? ["retrospective: collecting no-tools long-term observations"] : []),
      ]);
      return;
    }

    if (rootState?.bobsMode) {
      ctx.ui.setWidget("call", ["bobs-mode: root tools restricted to call, ask, and minitask"]);
      return;
    }

    ctx.ui.setWidget("call", undefined);
  }

  function refresh(ctx: ExtensionContext): void {
    const rootState = resolveRootState(ctx) ?? defaultRootState(pi.getActiveTools());
    const runtime = resolveRuntime(ctx);
    const retrospectivePending = runtime ? getLatestRetrospectivePending(ctx, runtime) !== undefined && !fs.existsSync(runtime.resultPath) : false;
    currentRootState = rootState;
    applyTools(rootState, runtime, retrospectivePending);
    updateUi(ctx, rootState, runtime, retrospectivePending);
  }

  async function startForkedCall(
    ctx: ExtensionContext,
    params: CallParams,
    toolCallId: string,
    onUpdate: ((partial: { content: Array<{ type: "text"; text: string }>; details: CallToolDetails }) => void) | undefined,
  ): Promise<{ result: CallResultFile; details: CallToolDetails }> {
    if (!isTmuxAvailable()) {
      throw new Error("call requires tmux; start pi inside a tmux session to use tmux-backed call frames.");
    }

    const parentSession = ctx.sessionManager.getSessionFile();
    if (!parentSession || !fs.existsSync(parentSession)) {
      throw new Error("Current session is not persisted; cannot fork a tmux call frame.");
    }

    const callId = makeCallId();
    const requestedLockName = sanitizeLockName(`call-${callId}`);
    const artifactPaths = createCallArtifacts(
      callId,
      callFrameInstructions(params.task, params.complex === true || params.retrospective === true),
    );
    const resultPath = artifactPaths.resultPath;
    const targetCwd = ctx.cwd;
    const preCallLeafId = getPreCallLeafId(ctx, toolCallId);
    const rootState = resolveRootState(ctx) ?? defaultRootState(pi.getActiveTools());
    const parentRuntime = resolveRuntime(ctx);
    const workerTools = captureWorkerTools(pi, rootState, parentRuntime);
    if (workerTools.length === 0) {
      throw new Error("Cannot start call frame: no worker tools are available after stripping call control tools.");
    }

    const forked = SessionManager.forkFrom(parentSession, targetCwd);
    const childSessionFile = forked.getSessionFile();
    if (!childSessionFile) {
      throw new Error("Could not create a persistent fork session for call frame.");
    }
    if (preCallLeafId === null) {
      forked.resetLeaf();
    } else {
      forked.branch(preCallLeafId);
    }

    const runtime: CallRuntimeState = {
      id: callId,
      task: params.task,
      complex: params.complex === true,
      retrospective: params.retrospective === true,
      resultPath,
      parentSession,
      childSession: childSessionFile,
      parentCwd: ctx.cwd,
      childCwd: targetCwd,
      lockName: requestedLockName,
      workerTools,
      createdAt: new Date().toISOString(),
    };
    forked.appendCustomEntry(CALL_RUNTIME_CUSTOM_TYPE, runtime);
    flushSessionFile(forked, childSessionFile);

    const startResult = await runTmux(
      pi,
      [
        "session-agent",
        requestedLockName,
        targetCwd,
        childSessionFile,
        "--status-only",
        ...getToolModelCliArgs(ctx),
        "--prompt-file",
        artifactPaths.promptPath,
      ],
    );
    const startText = [startResult.stdout.trim(), startResult.stderr.trim()].filter(Boolean).join("\n");
    if (startResult.code !== 0) {
      throw new Error(startText || "Failed to start tmux call frame.");
    }

    const actualLockName = parseActualLockName(startText, requestedLockName);
    const result = await waitForCallResult(pi, {
      id: callId,
      actualLockName,
      requestedLockName,
      resultPath,
      childSessionFile,
      task: params.task,
      complex: runtime.complex,
      retrospective: runtime.retrospective,
      onUpdate,
    });

    return {
      result,
      details: {
        id: callId,
        lockName: actualLockName,
        requestedLockName,
        resultPath,
        ...callDetailsArtifactFields(resultPath, runtime.retrospective),
        childSessionFile,
        task: params.task,
        complex: runtime.complex,
        retrospective: runtime.retrospective,
        elapsedMs: undefined,
        status: "finished",
      },
    };
  }

  function finishCallResultFromText(
    ctx: ExtensionContext,
    runtime: CallRuntimeState,
    result: string,
    skipRetrospective = false,
  ): "finished" | "retrospective" {
    clearDeferredCallFinalization(runtime);

    if (runtime.retrospective && !skipRetrospective && !getLatestRetrospectivePending(ctx, runtime)) {
      pi.appendEntry(RETROSPECTIVE_PENDING_CUSTOM_TYPE, {
        id: runtime.id,
        result,
        requestedAt: new Date().toISOString(),
      });
      pi.setActiveTools([]);
      updateUi(ctx, currentRootState, runtime, true);
      writeTextArtifact(callArtifactPathsFromResultPath(runtime.resultPath).resultMarkdownPath, result);

      try {
        pi.sendUserMessage(RETROSPECTIVE_PROMPT, { deliverAs: "followUp" });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const retrospective = `retrospective unavailable: ${reason}`;
        writeCallResult(
          runtime,
          appendRetrospective(result, retrospective),
          ctx.sessionManager.getSessionFile() ?? undefined,
          false,
          { resultMarkdown: result, reflectMarkdown: retrospective },
        );
        ctx.ui.notify("Finished call frame; retrospective prompt failed, so returned result with failure note.", "warning");
        ctx.shutdown();
        return "finished";
      }

      ctx.ui.notify("Saved call result; collecting retrospective before returning to parent.", "info");
      return "retrospective";
    }

    const reflectMarkdown = runtime.retrospective && skipRetrospective ? "retrospective bypassed by /finish-call-now." : undefined;
    const artifacts = reflectMarkdown === undefined
      ? { resultMarkdown: result }
      : { resultMarkdown: result, reflectMarkdown };
    writeCallResult(runtime, result, ctx.sessionManager.getSessionFile() ?? undefined, false, artifacts);
    ctx.ui.notify("Finished call frame with result; shutting down.", "info");
    ctx.shutdown();
    return "finished";
  }

  pi.registerTool({
    name: CALL_TOOL,
    label: "Call",
    description: "Run a delegated task in a forked tmux pi worker and return its result. Uses /tool-model when configured. Set retrospective when the task is likely to inspect more than about 5 files or do a deep design/code dive.",
    promptSnippet: "Run a delegated task in a forked tmux pi worker and return its result.",
    promptGuidelines: [
      "Use call for delegated operational work when the user asks for a separate worker.",
      "Use call as the only tool call in its assistant turn; sibling tool work is not included in the forked worker context.",
      "Use call.complex only when the worker may need to delegate substantial subtasks with nested call frames.",
      "Use call.retrospective when the delegated task is likely to inspect more than about 5 files, perform a deep code/design dive, or expose long-term architecture/naming cleanup observations; leave it off for small, narrow tasks.",
    ],
    parameters: callParams,
    renderCall: renderCallArgs,
    async execute(toolCallId, params: CallParams, _signal, onUpdate, ctx) {
      const runtime = resolveRuntime(ctx);
      if (runtime && !runtime.complex) {
        throw new Error("This call frame is not complex; nested call is disabled.");
      }

      const { result, details } = await startForkedCall(ctx, params, toolCallId, onUpdate);
      if (result.isError) {
        throw new Error(result.result);
      }
      return {
        content: [{ type: "text", text: result.result }],
        details,
      };
    },
  });

  pi.registerCommand("bobs-mode", {
    description: "Toggle Bob's mode: /bobs-mode [on|off|status|toggle]",
    getArgumentCompletions: (prefix) => {
      const actions = ["on", "off", "status", "toggle"];
      const matches = actions
        .filter((action) => action.startsWith(prefix.trim().toLowerCase()))
        .map((action) => ({ value: action, label: action }));
      return matches.length > 0 ? matches : null;
    },
    handler: async (args, ctx) => {
      await ctx.waitForIdle();
      const runtime = resolveRuntime(ctx);
      if (runtime) {
        ctx.ui.notify("bobs-mode is controlled by the parent outside this call frame.", "warning");
        return;
      }

      const rawAction = args?.trim().toLowerCase();
      const state = resolveRootState(ctx) ?? defaultRootState(pi.getActiveTools());
      const action = !rawAction || rawAction === "toggle" ? (state.bobsMode ? "off" : "on") : rawAction;

      if (action === "status") {
        ctx.ui.notify(`bobs-mode: ${state.bobsMode ? "on" : "off"}`, "info");
        return;
      }

      if (action === "on") {
        const next: RootCallState = {
          bobsMode: true,
          rootTools: stripControlTools(state.bobsMode ? state.rootTools : pi.getActiveTools()),
        };
        appendRootState(next);
        applyTools(next, undefined, false);
        updateUi(ctx, next, undefined, false);
        ctx.ui.notify("bobs-mode on: root tools restricted to call, ask, and minitask.", "info");
        return;
      }

      if (action === "off") {
        const next: RootCallState = { ...state, bobsMode: false };
        appendRootState(next);
        applyTools(next, undefined, false);
        updateUi(ctx, next, undefined, false);
        ctx.ui.notify("bobs-mode off: root tools restored.", "info");
        return;
      }

      ctx.ui.notify("Usage: /bobs-mode [on|off|status|toggle]", "warning");
    },
  });

  pi.registerCommand(FINISH_CALL_NOW_COMMAND, {
    description: "Immediately finish the active tmux call frame with a message, bypassing retrospective. Usage: /finish-call-now \"message\"",
    handler: async (args, ctx) => {
      const message = parseFinishCallNowText(args);
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

      const runtime = resolveRuntime(ctx);
      if (!runtime) {
        ctx.ui.notify("No active tmux call frame to finish.", "warning");
        return;
      }

      finishCallResultFromText(ctx, runtime, message, true);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    refresh(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    refresh(ctx);
  });

  pi.on("agent_end", async (event, ctx) => {
    const runtime = resolveRuntime(ctx);
    if (!runtime || fs.existsSync(runtime.resultPath)) return;

    const message = latestAssistantMessage(event.messages);
    if (!message) return;

    const pendingRetrospective = getLatestRetrospectivePending(ctx, runtime);
    if (pendingRetrospective) {
      if (message.stopReason === "aborted" || message.stopReason === "toolUse") return;

      const finishRetrospective = () => {
        const retrospectiveText = assistantTextContent(message) ?? message.errorMessage;
        const retrospective = message.stopReason === "stop"
          ? (retrospectiveText ?? "retrospective unavailable: assistant returned no retrospective text.")
          : `retrospective unavailable: assistant stopped with reason '${message.stopReason}'. ${retrospectiveText ?? "No retrospective text was returned."}`;
        writeCallResult(
          runtime,
          appendRetrospective(pendingRetrospective.result, retrospective),
          ctx.sessionManager.getSessionFile() ?? undefined,
          false,
          { resultMarkdown: pendingRetrospective.result, reflectMarkdown: retrospective },
        );
        ctx.ui.notify("Finished call frame with result and retrospective; shutting down.", "info");
        ctx.shutdown();
      };

      if (message.stopReason === "error") {
        scheduleDeferredCallFinalization(ctx, runtime, finishRetrospective);
        ctx.ui.notify("Call-frame retrospective hit a provider error; waiting for Pi retry before finalizing.", "warning");
        return;
      }

      try {
        finishRetrospective();
      } catch (error) {
        if (fs.existsSync(runtime.resultPath)) return;
        ctx.ui.notify(`Failed to write retrospective call result: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
      return;
    }

    if (message.stopReason === "stop") {
      const resultText = assistantTextContent(message);
      if (resultText) {
        try {
          finishCallResultFromText(ctx, runtime, resultText);
        } catch (error) {
          if (fs.existsSync(runtime.resultPath)) return;
          ctx.ui.notify(`Failed to write final call result: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
        return;
      }

      const reportEmptyResult = () => {
        writeCallResult(runtime, "Call frame stopped without final result text.", ctx.sessionManager.getSessionFile() ?? undefined, true);
        ctx.ui.notify("Call frame stopped without final result text; reported failure to parent.", "warning");
        ctx.shutdown();
      };

      try {
        reportEmptyResult();
      } catch (error) {
        if (fs.existsSync(runtime.resultPath)) return;
        ctx.ui.notify(`Failed to report empty call result: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
      return;
    }

    const failure = callFrameFailure(message);
    if (failure === undefined) return;

    const reportFailure = () => {
      writeCallResult(runtime, failure, ctx.sessionManager.getSessionFile() ?? undefined, true);
      ctx.ui.notify("Call frame ended without a final result; reported failure to parent.", "warning");
      ctx.shutdown();
    };

    if (message.stopReason === "error") {
      scheduleDeferredCallFinalization(ctx, runtime, reportFailure);
      ctx.ui.notify("Call frame hit a provider error before returning a final result; waiting for Pi retry before reporting failure.", "warning");
      return;
    }

    try {
      reportFailure();
    } catch (error) {
      if (fs.existsSync(runtime.resultPath)) return;
      ctx.ui.notify(`Failed to report missing call result: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  });

  pi.on("agent_start", async (_event, ctx) => {
    const runtime = resolveRuntime(ctx);
    if (runtime) clearDeferredCallFinalization(runtime);
  });

  pi.on("turn_start", async (_event, ctx) => {
    const runtime = resolveRuntime(ctx);
    if (runtime) clearDeferredCallFinalization(runtime);
  });

  pi.on("message_start", async (event, ctx) => {
    if (event.message.role !== "assistant") return;
    const runtime = resolveRuntime(ctx);
    if (runtime) clearDeferredCallFinalization(runtime);
  });

  pi.on("session_shutdown", async () => {
    clearDeferredCallFinalization();
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const runtime = resolveRuntime(ctx);
    if (runtime) {
      const pendingRetrospective = getLatestRetrospectivePending(ctx, runtime);
      if (pendingRetrospective) {
        return {
          systemPrompt: `${event.systemPrompt}\n\nYou are in the retrospective phase of a call frame. The main result is already saved for the parent. Do not call tools and do not continue the original task. Answer only the retrospective prompt.`,
        };
      }

      return {
        systemPrompt: [
          event.systemPrompt,
          callFrameInstructions(runtime.task, runtime.complex || runtime.retrospective),
          "When you are done, return the parent-facing result as your final assistant message.",
        ].join("\n\n"),
      };
    }

    const state = currentRootState;
    if (state?.bobsMode) {
      const workerTools = state.rootTools.length > 0
        ? ` A call frame will have access to these tools: ${state.rootTools.map((tool) => `\`${tool}\``).join(", ")}.`
        : "";
      return {
        systemPrompt: `${event.systemPrompt}\n\nTreat the root conversation as an orchestration thread, not a work thread. Default to call for any task, continuation, status check, recommendation, or question whose answer is not already fully available from compact root context. Use minitask for isolated fresh-context review or small independent questions that do not need this session's context. Use ask directly when a user decision or clarification is needed.${workerTools} Do not give generic next-step options when current project/session state is unknown; call a tmux-backed worker to inspect and return a compact recommendation. Answer directly only for purely conversational/conceptual questions or when recent compact call results already contain all needed facts.`,
      };
    }

    return undefined;
  });
}
