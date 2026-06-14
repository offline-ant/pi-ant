import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";

const CALL_TOOL = "call";
const RETURN_TOOL = "return";
const STATE_CUSTOM_TYPE = "pi-ant:call-state";
const MESSAGE_CUSTOM_TYPE = "pi-ant:call-message";
const RETURN_NOW_COMMAND = "return-now";

const callParams = Type.Object({
  task: Type.String({
    minLength: 1,
    description: "Task to complete in a call frame using the current conversation context.",
  }),
  complex: Type.Optional(
    Type.Boolean({
      description: "Allow this call frame to delegate substantial subtasks via nested call frames.",
    }),
  ),
});

type CallParams = Static<typeof callParams>;

const returnParams = Type.Object({
  result: Type.String({
    minLength: 1,
    description: "Exact text result to return to the call site.",
  }),
});

type ReturnParams = Static<typeof returnParams>;

type CallPhase = "starting" | "doing" | "returning" | "paused";

interface ActiveCallFrame {
  id: string;
  task: string;
  complex: boolean;
  phase: CallPhase;
  rootTools: string[];
  bobsMode: boolean;
  enforcementCount: number;
  returnPointId?: string;
  returnValue?: ReturnParams;
  callBranchLeafId?: string;
  reason?: string;
}

interface CallState {
  bobsMode: boolean;
  rootTools: string[];
  stack: ActiveCallFrame[];
}

interface CustomStateEntryLike {
  type: string;
  customType?: string;
  data?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.every((item) => typeof item === "string") ? value : undefined;
}

function isReturnParams(value: unknown): value is ReturnParams {
  return isRecord(value) && typeof value.result === "string";
}

function isCallPhase(value: unknown): value is CallPhase {
  return value === "starting" || value === "doing" || value === "returning" || value === "paused";
}

function parseActiveCallFrame(value: unknown): ActiveCallFrame | undefined {
  if (!isRecord(value)) return undefined;
  const id = value.id;
  const task = value.task;
  const phase = value.phase;
  const rootTools = stringArray(value.rootTools);
  const bobsMode = value.bobsMode;
  const enforcementCount = value.enforcementCount;
  const complex = value.complex;
  const returnPointId = value.returnPointId;
  const returnValue = value.returnValue;
  const callBranchLeafId = value.callBranchLeafId;
  const reason = value.reason;

  if (
    typeof id !== "string" ||
    typeof task !== "string" ||
    !isCallPhase(phase) ||
    rootTools === undefined ||
    typeof bobsMode !== "boolean" ||
    typeof enforcementCount !== "number" ||
    (complex !== undefined && typeof complex !== "boolean") ||
    (returnPointId !== undefined && typeof returnPointId !== "string") ||
    (returnValue !== undefined && !isReturnParams(returnValue)) ||
    (callBranchLeafId !== undefined && typeof callBranchLeafId !== "string") ||
    (reason !== undefined && typeof reason !== "string")
  ) {
    return undefined;
  }

  return {
    id,
    task,
    complex: typeof complex === "boolean" ? complex : false,
    phase,
    rootTools,
    bobsMode,
    enforcementCount,
    returnPointId: typeof returnPointId === "string" ? returnPointId : undefined,
    returnValue: isReturnParams(returnValue) ? returnValue : undefined,
    callBranchLeafId: typeof callBranchLeafId === "string" ? callBranchLeafId : undefined,
    reason: typeof reason === "string" ? reason : undefined,
  };
}

function parseActiveCallFrameArray(value: unknown): ActiveCallFrame[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const frames: ActiveCallFrame[] = [];
  for (const item of value) {
    const frame = parseActiveCallFrame(item);
    if (!frame) return undefined;
    frames.push(frame);
  }
  return frames;
}

function parseCallState(value: unknown): CallState | undefined {
  if (!isRecord(value)) return undefined;
  const bobsMode = value.bobsMode;
  const rootTools = stringArray(value.rootTools);
  if (typeof bobsMode !== "boolean" || rootTools === undefined) return undefined;

  if (value.stack !== undefined) {
    const stack = parseActiveCallFrameArray(value.stack);
    if (!stack) return undefined;
    return { bobsMode, rootTools, stack };
  }

  if (value.active !== undefined) {
    const active = parseActiveCallFrame(value.active);
    if (!active) return undefined;
    return { bobsMode, rootTools, stack: [active] };
  }

  return { bobsMode, rootTools, stack: [] };
}

function getCustomStateEntries(ctx: ExtensionContext): CustomStateEntryLike[] {
  const entries: CustomStateEntryLike[] = [];
  for (const entry of ctx.sessionManager.getBranch()) {
    if (!isRecord(entry) || typeof entry.type !== "string" || typeof entry.customType !== "string") continue;
    entries.push({ type: entry.type, customType: entry.customType, data: entry.data });
  }
  return entries;
}

function getLatestState(ctx: ExtensionContext): CallState | undefined {
  const entries = getCustomStateEntries(ctx);
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.customType === STATE_CUSTOM_TYPE) {
      const state = parseCallState(entry.data);
      if (state) return state;
    }
  }
  return undefined;
}

function defaultState(activeTools: string[]): CallState {
  return { bobsMode: false, rootTools: stripControlTools(activeTools), stack: [] };
}

function stripControlTools(tools: string[]): string[] {
  return tools.filter((tool) => tool !== CALL_TOOL && tool !== RETURN_TOOL);
}

function uniqueTools(tools: string[]): string[] {
  return [...new Set(tools)];
}

function topFrame(state: CallState | undefined): ActiveCallFrame | undefined {
  if (!state || state.stack.length === 0) return undefined;
  return state.stack[state.stack.length - 1];
}

function pushFrame(state: CallState, active: ActiveCallFrame): CallState {
  return { ...state, stack: [...state.stack, active] };
}

function replaceTopFrame(state: CallState, active: ActiveCallFrame): CallState {
  const stack = [...state.stack];
  if (stack.length === 0) {
    stack.push(active);
  } else {
    stack[stack.length - 1] = active;
  }
  return { ...state, stack };
}

function popTopFrame(state: CallState): CallState {
  return { ...state, stack: state.stack.slice(0, -1) };
}

function rootActiveTools(state: CallState): string[] {
  if (state.bobsMode) return [CALL_TOOL];
  return uniqueTools([...state.rootTools, CALL_TOOL]).filter((tool) => tool !== RETURN_TOOL);
}

function callFrameActiveTools(active: ActiveCallFrame): string[] {
  const tools = [...active.rootTools, RETURN_TOOL];
  if (active.complex) tools.push(CALL_TOOL);
  return uniqueTools(tools);
}

function formatReturn(value: ReturnParams): string {
  return value.result;
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

function activeToolsForState(state: CallState | undefined, fallbackTools: string[]): string[] {
  if (!state) return rootActiveTools(defaultState(fallbackTools));
  const active = topFrame(state);
  if (active && active.phase !== "paused" && active.phase !== "returning") {
    return callFrameActiveTools(active);
  }
  if (active?.phase === "returning") {
    return activeToolsForState(popTopFrame(state), fallbackTools);
  }
  return rootActiveTools(state);
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

function messageText(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === "string") return content;
  return content
    .filter((item): item is { type: "text"; text: string } => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");
}

function callPrompt(task: string, complex: boolean): string {
  return [
    "You are inside a call frame.",
    "Use the available tools to complete the delegated task in this same session branch.",
    complex
      ? "This is a complex call frame. You may use the call tool for substantial delegated subtasks; otherwise work directly."
      : "Do not call the call tool or delegate recursively.",
    "Before finishing, call return exactly once with { result: \"...\" }.",
    "If you are blocked or the task is already complete, put that concise state directly in result.",
    "",
    "Task:",
    task,
  ].join("\n");
}

function statusText(state: CallState | undefined): string | undefined {
  if (!state) return undefined;
  const active = topFrame(state);
  if (active) return `call:${state.stack.length}:${active.phase}`;
  return state.bobsMode ? "bobs:on" : undefined;
}

export default function (pi: ExtensionAPI) {
  pi.registerMessageRenderer(MESSAGE_CUSTOM_TYPE, (message, _options, theme) => {
    const text = messageText(message.content);
    const lines = [theme.fg("accent", "[return]"), ...text.split("\n")];
    return {
      render: (contentWidth: number) => lines.flatMap((line) => wrapTextWithAnsi(line, contentWidth)),
      invalidate: () => {
        /* no-op */
      },
    };
  });

  let currentState: CallState | undefined;
  let terminateCallTurn = false;

  function resolveState(ctx: ExtensionContext): CallState | undefined {
    const persisted = getLatestState(ctx);
    if (currentState && currentState.stack.length > 0) return currentState;
    return persisted ?? currentState;
  }

  function appendState(state: CallState): void {
    currentState = state;
    pi.appendEntry(STATE_CUSTOM_TYPE, state);
  }

  function applyTools(state: CallState | undefined): void {
    pi.setActiveTools(activeToolsForState(state, pi.getActiveTools()));
  }

  function updateUi(ctx: ExtensionContext, state: CallState | undefined): void {
    const status = statusText(state);
    ctx.ui.setStatus("call", status ? ctx.ui.theme.fg("accent", status) : undefined);
    if (!state) {
      ctx.ui.setWidget("call", undefined);
      return;
    }
    const lines: string[] = [];
    const active = topFrame(state);
    if (active) {
      lines.push(`call frame: ${active.phase} (depth ${state.stack.length})`);
      lines.push(`nested call: ${active.complex ? "allowed" : "disabled"}`);
      lines.push(`task: ${active.task.slice(0, 160)}${active.task.length > 160 ? "…" : ""}`);
      if (state.stack.length > 1) {
        const parent = state.stack[state.stack.length - 2];
        lines.push(`parent: ${parent.task.slice(0, 120)}${parent.task.length > 120 ? "…" : ""}`);
      }
      if (active.reason) lines.push(`reason: ${active.reason}`);
    }
    ctx.ui.setWidget("call", lines.length > 0 ? lines : undefined);
  }

  function setState(ctx: ExtensionContext, state: CallState): void {
    appendState(state);
    applyTools(state);
    updateUi(ctx, state);
  }

  async function finishReturn(
    ctx: ExtensionCommandContext,
    state: CallState,
    active: ActiveCallFrame,
    options: { triggerTurn: boolean },
  ): Promise<boolean> {
    if (!active.returnValue || !active.returnPointId) {
      ctx.ui.notify("No complete call return is ready to finish.", "warning");
      return false;
    }

    const callBranchLeafId = active.callBranchLeafId ?? ctx.sessionManager.getLeafId() ?? undefined;
    const returnedActive: ActiveCallFrame = { ...active, callBranchLeafId };
    const result = await ctx.navigateTree(active.returnPointId, { suppressStatus: true });
    if (result.cancelled) {
      setState(ctx, replaceTopFrame(state, { ...returnedActive, phase: "paused", reason: "return navigation was cancelled" }));
      ctx.ui.notify("call return navigation cancelled; call is paused.", "warning");
      return false;
    }

    const nextState = popTopFrame(state);
    setState(ctx, nextState);
    const content = formatReturn(active.returnValue);
    pi.sendMessage(
      {
        customType: MESSAGE_CUSTOM_TYPE,
        content,
        display: true,
        details: { active: returnedActive, returnValue: active.returnValue },
      },
      { triggerTurn: options.triggerTurn },
    );
    return true;
  }

  pi.registerTool({
    name: CALL_TOOL,
    label: "Call",
    description: "Enter a call frame to do work.",
    promptSnippet: "Enter a call frame to do work.",
    parameters: callParams,
    renderCall: renderCallArgs,
    renderResult() {
      return {
        render: () => [],
        invalidate: () => {
          /* no-op */
        },
      };
    },
    async execute(_toolCallId, params: CallParams, _signal, _onUpdate, ctx) {
      const state = resolveState(ctx) ?? defaultState(pi.getActiveTools());
      const parent = topFrame(state);
      let baseState = state;
      if (parent && parent.phase === "paused") {
        baseState = { ...state, stack: [] };
      } else if (parent && (parent.phase !== "doing" || !parent.complex)) {
        throw new Error(
          "A call frame is already active; finish it with return before starting another call frame, or start the parent call with complex: true to allow nested calls.",
        );
      }

      const activeParent = topFrame(baseState);
      const rootTools = activeParent
        ? activeParent.rootTools
        : baseState.bobsMode
          ? baseState.rootTools
          : stripControlTools(pi.getActiveTools());
      const active: ActiveCallFrame = {
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        task: params.task,
        complex: params.complex === true,
        phase: "starting",
        rootTools,
        bobsMode: activeParent?.bobsMode ?? baseState.bobsMode,
        enforcementCount: 0,
      };
      setState(ctx, pushFrame(baseState, active));
      return {
        content: [
          {
            type: "text",
            text: `Entering call frame ${active.id}${active.complex ? " (complex)" : ""}. The call task will run with normal tools and must finish with return.`,
          },
        ],
        details: { id: active.id, task: params.task, complex: active.complex },
        terminate: true,
      };
    },
  });

  pi.registerTool({
    name: RETURN_TOOL,
    label: "Return",
    description: "Return exact text from the call frame to the call site.",
    promptSnippet: "Return exact text from the call frame to the call site",
    parameters: returnParams,
    async execute(_toolCallId, params: ReturnParams, _signal, _onUpdate, ctx) {
      const state = resolveState(ctx);
      const active = topFrame(state);
      if (!state || !active || active.phase !== "doing") {
        throw new Error("No active call frame is ready to return.");
      }
      if (!active.returnPointId) {
        throw new Error("The active call frame has no return point yet.");
      }

      const returning: ActiveCallFrame = {
        ...active,
        phase: "returning",
        returnValue: params,
        callBranchLeafId: ctx.sessionManager.getLeafId() ?? undefined,
      };
      const returningState = replaceTopFrame(state, returning);
      setState(ctx, returningState);
      ctx.clearQueue();
      ctx.scheduleAfterAgent(async (commandCtx) => {
        const latestState = currentState;
        const latestActive = topFrame(latestState);
        if (!latestState || !latestActive || latestActive.id !== returning.id || latestActive.phase !== "returning") {
          return undefined;
        }
        const continueAgent = await finishReturn(commandCtx, latestState, latestActive, { triggerTurn: false });
        return { continueAgent };
      });
      return {
        content: [{ type: "text", text: "Returning to the call site." }],
        details: params,
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
      const rawAction = args?.trim().toLowerCase();
      const state = resolveState(ctx) ?? defaultState(pi.getActiveTools());
      const action = !rawAction || rawAction === "toggle" ? (state.bobsMode ? "off" : "on") : rawAction;

      if (action === "status") {
        const active = topFrame(state);
        const activeText = active ? `, call=${state.stack.length}:${active.phase}` : "";
        ctx.ui.notify(`bobs-mode: ${state.bobsMode ? "on" : "off"}${activeText}`, "info");
        return;
      }

      if (action === "on") {
        const next: CallState = {
          ...state,
          bobsMode: true,
          rootTools: stripControlTools(state.bobsMode ? state.rootTools : pi.getActiveTools()),
        };
        setState(ctx, next);
        ctx.ui.notify("bobs-mode on: root tools restricted to call.", "info");
        return;
      }

      if (action === "off") {
        const next: CallState = { ...state, bobsMode: false };
        setState(ctx, next);
        ctx.ui.notify("bobs-mode off: root tools restored.", "info");
        return;
      }

      ctx.ui.notify("Usage: /bobs-mode [on|off|status|toggle]", "warning");
    },
  });

  pi.registerCommand(RETURN_NOW_COMMAND, {
    description: "Force-return from the active call frame with an error message. Usage: /return-now \"message\"",
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

      const state = resolveState(ctx);
      const active = topFrame(state);
      if (!state || !active) {
        ctx.ui.notify("No active call frame to return from.", "warning");
        return;
      }
      if (!active.returnPointId) {
        ctx.ui.notify("The active call frame does not have a return point yet.", "warning");
        return;
      }

      const returning: ActiveCallFrame = {
        ...active,
        phase: "returning",
        returnValue: { result: message },
        callBranchLeafId: ctx.sessionManager.getLeafId() ?? undefined,
      };
      const returningState = replaceTopFrame(state, returning);
      setState(ctx, returningState);
      ctx.clearQueue();
      ctx.ui.setEditorText?.("");
      await finishReturn(ctx, returningState, returning, { triggerTurn: true });
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    currentState = getLatestState(ctx) ?? defaultState(pi.getActiveTools());
    applyTools(currentState);
    updateUi(ctx, currentState);
  });

  pi.on("session_tree", async (_event, ctx) => {
    currentState = getLatestState(ctx) ?? defaultState(pi.getActiveTools());
    applyTools(currentState);
    updateUi(ctx, currentState);
  });

  pi.on("tool_execution_start", async (event) => {
    if (event.toolName === CALL_TOOL) terminateCallTurn = true;
  });

  pi.on("tool_result", async () => {
    const active = topFrame(currentState);
    if (terminateCallTurn && active?.phase === "starting") {
      return { terminate: true };
    }
    return undefined;
  });

  pi.on("turn_end", async () => {
    terminateCallTurn = false;
  });

  pi.on("before_agent_start", async (event) => {
    const state = currentState;
    const active = topFrame(state);
    if (active && active.phase === "doing") {
      const delegationGuidance = active.complex
        ? "You may call the call tool for substantial delegated subtasks."
        : "Do not call the call tool.";
      return {
        systemPrompt: `${event.systemPrompt}\n\nYou are inside a call frame. Complete the delegated task using tools as needed. ${delegationGuidance} End by calling return exactly once with { result: \"...\" }; put the exact text that should be returned to the caller in result.`,
      };
    }
    if (state?.bobsMode && state.stack.length === 0) {
      return {
        systemPrompt: `${event.systemPrompt}\n\nBob's mode is active. Treat the root conversation as an orchestration thread, not a work thread. Default to call for any task, continuation, status check, recommendation, or question whose answer is not already fully available from compact root context. Do not give generic next-step options when current project/session state is unknown; call a frame to inspect and return a compact recommendation. Answer directly only for purely conversational/conceptual questions or when recent compact call results already contain all needed facts.`,
      };
    }
    return undefined;
  });

  pi.on("agent_end", async (_event, ctx) => {
    const state = resolveState(ctx);
    const active = topFrame(state);
    if (!state || !active) return;

    if (active.phase === "starting") {
      const doing: ActiveCallFrame = {
        ...active,
        phase: "doing",
        returnPointId: ctx.sessionManager.getLeafId() ?? undefined,
      };
      setState(ctx, replaceTopFrame(state, doing));
      void pi.sendUserMessage(callPrompt(active.task, active.complex), { deliverAs: "followUp" });
      return;
    }

    if (active.phase !== "doing") return;

    const editorText = ctx.ui.getEditorText?.() ?? "";
    if (editorText.trim().length > 0) {
      ctx.ui.notify("call frame is still active; call return when finished.", "warning");
      return;
    }

    if (active.enforcementCount >= 1) {
      setState(ctx, {
        ...replaceTopFrame(state, {
          ...active,
          phase: "paused",
          reason: "call frame stopped without return after reminder",
        }),
      });
      ctx.ui.notify("call paused: worker stopped without calling return.", "warning");
      return;
    }

    const reminded: ActiveCallFrame = { ...active, enforcementCount: active.enforcementCount + 1 };
    setState(ctx, replaceTopFrame(state, reminded));
    void pi.sendUserMessage(
      "You are still inside a call frame. Call return now with { result: \"...\" }. Put the exact concise text that should be returned to the caller in result. Do not do more work unless needed to produce an accurate return.",
      { deliverAs: "followUp" },
    );
  });
}
