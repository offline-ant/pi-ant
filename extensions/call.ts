import * as fs from "node:fs";
import { SessionManager, type AgentToolUpdateCallback, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { flushSessionFile, runTmux } from "./tmux-helpers.ts";
import { getToolModelCliArgs } from "./tool-model-state.ts";
import {
  appendWorkerMoreInfo,
  createWorkerArtifacts,
  formatWorkerMoreInfo,
  formatWorkerResult,
  makeWorkerId,
  parseActualLockName,
  sanitizeWorkerName,
  waitForWorkerReady,
  waitForWorkerResult,
  writeWorkerRequest,
  type WorkerArtifactPaths,
} from "./worker-frame.ts";

const CALL_TOOL = "call";
const CODING_AGENT_TOOL = "coding-agent";
const ASK_TOOL = "ask";
const MINITASK_TOOL = "minitask";
const REMOVED_CALL_CONTROL_TOOLS = new Set(["finish_call", "return"]);
const ROOT_STATE_CUSTOM_TYPE = "pi-ant:call-state";
const CALL_RUNTIME_CUSTOM_TYPE = "pi-ant:call-runtime";
const DESIGN_PRINCIPLES_PROMPT = [
  "Note our design principles: Do the hard part first, clean up as you go, leave no dead code or overcomplicated abstractions behind,",
  "being broken between phases is fine, cost of change is 0, avoid quick fixes / hacks, the well-designed long-term architecture end state is critical.",
  "Clear, consistent names are important; immediately refactor and rename things to best describe reality.",
].join(" ");

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

interface CallToolDetails {
  id: string;
  lockName: string;
  requestedLockName: string;
  resultPath: string;
  artifactDir: string;
  requestPath: string;
  resultMarkdownPath: string;
  retrospectiveMarkdownPath?: string;
  sessionFile: string;
  sessionCommand: string;
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

function stripControlTools(tools: string[]): string[] {
  return tools.filter((tool) => tool !== CALL_TOOL && !REMOVED_CALL_CONTROL_TOOLS.has(tool));
}

function parseRootCallState(value: unknown): RootCallState | undefined {
  if (!isRecord(value)) return undefined;
  const rootTools = stringArray(value.rootTools);
  if (typeof value.bobsMode !== "boolean" || rootTools === undefined) return undefined;
  return { bobsMode: value.bobsMode, rootTools: stripControlTools(rootTools) };
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

function uniqueTools(tools: string[]): string[] {
  return [...new Set(tools)];
}

function rootActiveTools(state: RootCallState): string[] {
  if (state.bobsMode) return [CALL_TOOL, CODING_AGENT_TOOL, ASK_TOOL, MINITASK_TOOL];
  return uniqueTools([...state.rootTools, CALL_TOOL]);
}

function runtimeActiveTools(runtime: CallRuntimeState): string[] {
  return uniqueTools([...runtime.workerTools, ...(runtime.complex ? [CALL_TOOL] : [])]);
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

function createCallDetails(paths: WorkerArtifactPaths, id: string, actualLockName: string, requestedLockName: string, sessionFile: string, params: CallParams): CallToolDetails {
  return {
    id,
    lockName: actualLockName,
    requestedLockName,
    resultPath: paths.resultPath,
    artifactDir: paths.artifactDir,
    requestPath: paths.requestPath,
    resultMarkdownPath: paths.resultMarkdownPath,
    ...(params.retrospective === true ? { retrospectiveMarkdownPath: paths.retrospectiveMarkdownPath } : {}),
    sessionFile,
    sessionCommand: `pi --session ${sessionFile}`,
    task: params.task,
    complex: params.complex === true,
    retrospective: params.retrospective === true,
    status: "finished",
  };
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
      ]);
      return;
    }

    if (rootState?.bobsMode) {
      ctx.ui.setWidget("call", ["bobs-mode: root tools restricted to call, coding-agent, ask, and minitask"]);
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
    onUpdate: AgentToolUpdateCallback | undefined,
  ): Promise<{ resultText: string; details: CallToolDetails }> {
    if (!isTmuxAvailable()) {
      throw new Error("call requires tmux; start pi inside a tmux session to use tmux-backed call frames.");
    }

    const parentSession = ctx.sessionManager.getSessionFile();
    if (!parentSession || !fs.existsSync(parentSession)) {
      throw new Error("Current session is not persisted; cannot fork a tmux call frame.");
    }

    const callId = makeWorkerId();
    const requestedLockName = sanitizeWorkerName(`call-${callId}`);
    const paths = createWorkerArtifacts(callId);
    const retrospective = params.retrospective === true;
    try {
      writeWorkerRequest(paths, {
        id: callId,
        task: callFrameInstructions(params.task, params.complex === true || retrospective),
        resultPath: paths.resultPath,
        statusPath: paths.statusPath,
        retrospective,
        closeWhenDone: true,
      });

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
        ],
        signal,
      );
      const startText = [startResult.stdout.trim(), startResult.stderr.trim()].filter(Boolean).join("\n");
      if (startResult.code !== 0) {
        throw new Error(startText || "Failed to start tmux call frame.");
      }

      const actualLockName = parseActualLockName(startText, requestedLockName);
      await waitForWorkerReady(pi, actualLockName, 10_000, signal);
      const sendResult = await runTmux(pi, ["send", actualLockName, `/worker-run ${paths.requestPath}`], signal);
      if (sendResult.code !== 0) {
        throw new Error(sendResult.stdout.trim() || sendResult.stderr.trim() || "Failed to send worker request to call frame.");
      }

      const { result, details } = await waitForWorkerResult(pi, {
        id: callId,
        actualLockName,
        requestedLockName,
        paths,
        sessionFile: childSessionFile,
        task: params.task,
        retrospective,
        signal,
        onUpdate,
      });
      const resultText = formatWorkerResult(result);
      if (result.isError) throw new Error(appendWorkerMoreInfo(resultText, paths, retrospective));

      return {
        resultText: `${resultText}\n\n${formatWorkerMoreInfo(paths, retrospective)}`,
        details: { ...createCallDetails(paths, callId, actualLockName, requestedLockName, childSessionFile, params), elapsedMs: details.elapsedMs },
      };
    } catch (error) {
      throw new Error(appendWorkerMoreInfo(error instanceof Error ? error.message : String(error), paths, retrospective));
    }
  }

  pi.registerTool({
    name: CALL_TOOL,
    label: "Call",
    description: "Run a delegated task in a forked tmux pi worker and return its result. Uses /tool-model when configured. Set retrospective when the task is likely to inspect more than about 5 files or do a deep design/code dive.",
    promptSnippet: "Run a delegated task in a forked tmux pi worker and return its result.",
    promptGuidelines: [
      "Use call for delegated operational work when the user asks for a separate worker or when current conversation context matters.",
      "Use call as the only tool call in its assistant turn; sibling tool work is not included in the forked worker context.",
      "When the user asks to use call for a plan, range, or phases, act as coordinator: split the work into the fewest cohesive focused batches and invoke call separately for each. Do not pass the whole plan to one call unless it is truly atomic or the user explicitly asks for a single call.",
      "Use call.complex only when the worker may need delegated subtasks with nested call frames.",
      "Use call.retrospective when the delegated task is likely to inspect more than about 5 files, perform a deep code/design dive, or expose long-term architecture/naming cleanup observations; leave it off for small, narrow tasks.",
    ],
    parameters: callParams,
    renderCall: renderCallArgs,
    async execute(toolCallId, params: CallParams, signal, onUpdate, ctx) {
      const runtime = resolveRuntime(ctx);
      if (runtime && !runtime.complex) {
        throw new Error("This call frame is not complex; nested call is disabled.");
      }

      const { resultText, details } = await startForkedCall(ctx, params, toolCallId, signal, onUpdate);
      return {
        content: [{ type: "text", text: resultText }],
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
        applyTools(next, undefined);
        updateUi(ctx, next, undefined);
        ctx.ui.notify("bobs-mode on: root tools restricted to call, coding-agent, ask, and minitask.", "info");
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

  pi.on("session_start", async (_event, ctx) => {
    refresh(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    refresh(ctx);
  });

  pi.on("before_agent_start", async (event) => {
    const runtime = currentRuntime;
    if (runtime) {
      return {
        systemPrompt: [
          event.systemPrompt,
          "You are running inside a tmux call frame. Complete the worker request you were given and return the parent-facing result as your final assistant message.",
        ].join("\n\n"),
      };
    }

    const state = currentRootState;
    if (state?.bobsMode) {
      const workerTools = state.rootTools.length > 0
        ? ` A call frame will have access to these tools: ${state.rootTools.map((tool) => `\`${tool}\``).join(", ")}.`
        : "";
      return {
        systemPrompt: `${event.systemPrompt}\n\nTreat the root conversation as an orchestration thread, not a work thread. Default to call for any task, continuation, status check, recommendation, or question whose answer is not already fully available from compact root context. Use coding-agent for fresh-context persistent worker tasks. Use minitask for isolated fresh-context review or small independent questions that do not need this session's context. Use ask directly when a user decision or clarification is needed.${workerTools} Do not give generic next-step options when current project/session state is unknown; call a tmux-backed worker to inspect and return a compact recommendation. Answer directly only for purely conversational/conceptual questions or when recent compact worker results already contain all needed facts.`,
      };
    }

    return undefined;
  });
}
