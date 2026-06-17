import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { flushSessionFile, runTmux, writePromptFile } from "./tmux-helpers.ts";
import { getToolModelCliArgs } from "./tool-model-state.ts";

const CALL_TOOL = "call";
const RETURN_TOOL = "return";
const ROOT_STATE_CUSTOM_TYPE = "pi-ant:call-state";
const CALL_RUNTIME_CUSTOM_TYPE = "pi-ant:call-runtime";
const RETURN_NOW_COMMAND = "return-now";
const RESULT_POLL_INTERVAL_MS = 250;
const PROGRESS_UPDATE_INTERVAL_MS = 5000;
const LOCK_DIR = "/tmp/pi-semaphores";

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
});

type CallParams = Static<typeof callParams>;

const returnParams = Type.Object({
  result: Type.String({
    minLength: 1,
    description: "Exact text result to return to the parent call frame.",
  }),
});

type ReturnParams = Static<typeof returnParams>;

interface RootCallState {
  bobsMode: boolean;
  rootTools: string[];
}

interface CallRuntimeState {
  id: string;
  task: string;
  complex: boolean;
  resultPath: string;
  parentSession: string;
  childSession: string;
  parentCwd: string;
  childCwd: string;
  lockName: string;
  workerTools: string[];
  createdAt: string;
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
}

interface CallToolDetails {
  id: string;
  lockName: string;
  requestedLockName: string;
  resultPath: string;
  childSessionFile: string;
  task: string;
  complex: boolean;
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

function defaultRootState(activeTools: string[]): RootCallState {
  return { bobsMode: false, rootTools: stripControlTools(activeTools) };
}

function stripControlTools(tools: string[]): string[] {
  return tools.filter((tool) => tool !== CALL_TOOL && tool !== RETURN_TOOL);
}

function uniqueTools(tools: string[]): string[] {
  return [...new Set(tools)];
}

function rootActiveTools(state: RootCallState): string[] {
  if (state.bobsMode) return [CALL_TOOL];
  return uniqueTools([...state.rootTools, CALL_TOOL]).filter((tool) => tool !== RETURN_TOOL);
}

function runtimeActiveTools(runtime: CallRuntimeState): string[] {
  return uniqueTools([...runtime.workerTools, RETURN_TOOL, ...(runtime.complex ? [CALL_TOOL] : [])]);
}

function parseReturnNowText(args: string | undefined): string {
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

function renderReturnArgs(args: ReturnParams) {
  const lines = args.result.split("\n");
  return {
    render: (contentWidth: number) => lines.flatMap((line) => wrapTextWithAnsi(line, contentWidth)),
    invalidate: () => {
      /* no-op */
    },
  };
}

function callFrameInstructions(task: string): string {
  return [
    "You have stepped inside a call frame. Use the available tools to complete the task below. Do not stop until you call `return({ result: \"...\" })` with the result for the caller, or the cause of failure.",
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

function createResultPath(callId: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-ant-call-${callId}-`));
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // Best effort; mkdtemp already respects the process umask.
  }
  return path.join(dir, "result.json");
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
  };
}

function writeCallResult(runtime: CallRuntimeState, result: string, sessionFile: string | undefined): void {
  fs.mkdirSync(path.dirname(runtime.resultPath), { recursive: true, mode: 0o700 });
  const tmp = `${runtime.resultPath}.${process.pid}.${Date.now()}.tmp`;
  const payload: CallResultFile = {
    id: runtime.id,
    result,
    timestamp: new Date().toISOString(),
    sessionFile,
  };

  fs.writeFileSync(tmp, `${JSON.stringify(payload)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try {
    fs.linkSync(tmp, runtime.resultPath);
  } catch (error) {
    if (isRecord(error) && error.code === "EEXIST") {
      throw new Error(`Call result already exists; duplicate return refused: ${runtime.resultPath}`);
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

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error("Call frame aborted"));
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(new Error("Call frame aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
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

async function killTmuxPane(pi: ExtensionAPI, lockName: string): Promise<void> {
  try {
    await runTmux(pi, ["kill", lockName]);
  } catch {
    // Best effort on abort.
  }
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
    signal?: AbortSignal;
    onUpdate?: (partial: { content: Array<{ type: "text"; text: string }>; details: CallToolDetails }) => void;
  },
): Promise<CallResultFile> {
  const startedAt = Date.now();
  let lastProgressAt = 0;

  while (true) {
    if (fs.existsSync(options.resultPath)) {
      return parseCallResult(fs.readFileSync(options.resultPath, "utf8"), options.resultPath, options.id);
    }

    if (options.signal?.aborted) {
      await killTmuxPane(pi, options.actualLockName);
      throw new Error("Call frame aborted");
    }

    const elapsedMs = Date.now() - startedAt;
    if (isLockFinished(options.actualLockName)) {
      if (fs.existsSync(options.resultPath)) {
        return parseCallResult(fs.readFileSync(options.resultPath, "utf8"), options.resultPath, options.id);
      }
      const output = await captureTmuxOutput(pi, options.actualLockName);
      throw new Error(
        [
          "Call frame exited before writing a return result.",
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
          childSessionFile: options.childSessionFile,
          task: options.task,
          complex: options.complex,
          elapsedMs,
          status: "waiting",
        },
      });
    }

    await delay(RESULT_POLL_INTERVAL_MS, options.signal);
  }
}

export default function (pi: ExtensionAPI) {
  let currentRootState: RootCallState | undefined;
  let currentRuntime: CallRuntimeState | undefined;

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

  function applyTools(rootState: RootCallState | undefined, runtime: CallRuntimeState | undefined): void {
    if (runtime) {
      pi.setActiveTools(runtimeActiveTools(runtime));
      return;
    }
    pi.setActiveTools(rootActiveTools(rootState ?? defaultRootState(pi.getActiveTools())));
  }

  function updateUi(ctx: ExtensionContext, rootState: RootCallState | undefined, runtime: CallRuntimeState | undefined): void {
    const status = statusText(rootState, runtime);
    ctx.ui.setStatus("call", status ? ctx.ui.theme.fg("accent", status) : undefined);

    if (runtime) {
      ctx.ui.setWidget("call", [
        `tmux call frame${runtime.complex ? " (complex)" : ""}`,
        `task: ${runtime.task.slice(0, 160)}${runtime.task.length > 160 ? "…" : ""}`,
        `return target: ${runtime.resultPath}`,
      ]);
      return;
    }

    if (rootState?.bobsMode) {
      ctx.ui.setWidget("call", ["bobs-mode: root tools restricted to call"]);
      return;
    }

    ctx.ui.setWidget("call", undefined);
  }

  function refresh(ctx: ExtensionContext): void {
    const rootState = resolveRootState(ctx) ?? defaultRootState(pi.getActiveTools());
    const runtime = resolveRuntime(ctx);
    currentRootState = rootState;
    applyTools(rootState, runtime);
    updateUi(ctx, rootState, runtime);
  }

  async function startForkedCall(
    ctx: ExtensionContext,
    params: CallParams,
    toolCallId: string,
    signal: AbortSignal | undefined,
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
    const resultPath = createResultPath(callId);
    const targetCwd = ctx.cwd;
    const preCallLeafId = getPreCallLeafId(ctx, toolCallId);
    const rootState = resolveRootState(ctx) ?? defaultRootState(pi.getActiveTools());
    const parentRuntime = resolveRuntime(ctx);
    const workerTools = captureWorkerTools(pi, rootState, parentRuntime);
    if (workerTools.length === 0) {
      throw new Error("Cannot start call frame: no worker tools are available after stripping call/return.");
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

    const promptFile = writePromptFile(callFrameInstructions(params.task), "pi-ant-call-prompt-");
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
        promptFile,
      ],
      signal,
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
      signal,
      onUpdate,
    });

    return {
      result,
      details: {
        id: callId,
        lockName: actualLockName,
        requestedLockName,
        resultPath,
        childSessionFile,
        task: params.task,
        complex: runtime.complex,
        elapsedMs: undefined,
        status: "returned",
      },
    };
  }

  function returnFromRuntime(ctx: ExtensionContext, runtime: CallRuntimeState, params: ReturnParams): void {
    writeCallResult(runtime, params.result, ctx.sessionManager.getSessionFile() ?? undefined);
    ctx.ui.notify("Returned call result; shutting down.", "info");
    ctx.shutdown();
  }

  pi.registerTool({
    name: CALL_TOOL,
    label: "Call",
    description: "Run a delegated task in a forked tmux pi worker and return its result. Uses /tool-model when configured.",
    promptSnippet: "Run a delegated task in a forked tmux pi worker and return its result.",
    promptGuidelines: [
      "Use call for delegated operational work when Bob's mode is active or when the user asks for a separate worker.",
      "Use call as the only tool call in its assistant turn; sibling tool work is not included in the forked worker context.",
      "Use call.complex only when the worker may need to delegate substantial subtasks with nested call frames.",
    ],
    parameters: callParams,
    renderCall: renderCallArgs,
    async execute(toolCallId, params: CallParams, signal, onUpdate, ctx) {
      const runtime = resolveRuntime(ctx);
      if (runtime && !runtime.complex) {
        throw new Error("This call frame is not complex; nested call is disabled.");
      }

      const { result, details } = await startForkedCall(ctx, params, toolCallId, signal, onUpdate);
      return {
        content: [{ type: "text", text: result.result }],
        details,
      };
    },
  });

  pi.registerTool({
    name: RETURN_TOOL,
    label: "Return",
    description: "Return exact text from the tmux call frame to the parent call tool.",
    promptSnippet: "Return exact text from the tmux call frame to the parent call tool",
    parameters: returnParams,
    renderCall: renderReturnArgs,
    async execute(_toolCallId, params: ReturnParams, _signal, _onUpdate, ctx) {
      const runtime = resolveRuntime(ctx);
      if (!runtime) {
        throw new Error("No active tmux call frame is available to return from.");
      }

      returnFromRuntime(ctx, runtime, params);
      return {
        content: [{ type: "text", text: "Returned result to parent call frame. Shutting down." }],
        details: { id: runtime.id, resultPath: runtime.resultPath },
        terminate: true,
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
        applyTools(next, undefined);
        updateUi(ctx, next, undefined);
        ctx.ui.notify("bobs-mode on: root tools restricted to call.", "info");
        return;
      }

      if (action === "off") {
        const next: RootCallState = { ...state, bobsMode: false };
        appendRootState(next);
        applyTools(next, undefined);
        updateUi(ctx, next, undefined);
        ctx.ui.notify("bobs-mode off: root tools restored.", "info");
        return;
      }

      ctx.ui.notify("Usage: /bobs-mode [on|off|status|toggle]", "warning");
    },
  });

  pi.registerCommand(RETURN_NOW_COMMAND, {
    description: "Return from the active tmux call frame with a message. Usage: /return-now \"message\"",
    handler: async (args, ctx) => {
      const message = parseReturnNowText(args);
      if (!message) {
        ctx.ui.notify("Usage: /return-now \"message\"", "warning");
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
        ctx.ui.notify("No active tmux call frame to return from.", "warning");
        return;
      }

      returnFromRuntime(ctx, runtime, { result: message });
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    refresh(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    refresh(ctx);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const runtime = resolveRuntime(ctx);
    if (runtime) {
      return {
        systemPrompt: `${event.systemPrompt}\n\n${callFrameInstructions(runtime.task)}\n\nDo not answer normally instead of returning.`,
      };
    }

    const state = currentRootState;
    if (state?.bobsMode) {
      return {
        systemPrompt: `${event.systemPrompt}\n\nBob's mode is active. Treat the root conversation as an orchestration thread, not a work thread. Default to call for any task, continuation, status check, recommendation, or question whose answer is not already fully available from compact root context. Do not give generic next-step options when current project/session state is unknown; call a tmux-backed worker to inspect and return a compact recommendation. Answer directly only for purely conversational/conceptual questions or when recent compact call results already contain all needed facts.`,
      };
    }

    return undefined;
  });
}
