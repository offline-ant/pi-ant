import * as fs from "node:fs";
import { SessionManager, type AgentToolUpdateCallback, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { flushSessionFile, sendTextToPane, startHerdrPiPane } from "./herdr-helpers.ts";
import { getSubagentModelCliArgs } from "./subagent-model-state.ts";
import {
  appendWorkerMoreInfo,
  createWorkerArtifacts,
  formatWorkerResult,
  makeWorkerId,
  sanitizeWorkerName,
  waitForWorkerReady,
  waitForWorkerResult,
  writeWorkerRequest,
  type WorkerArtifactPaths,
} from "./worker-frame.ts";
import { WORKER_DESIGN_PRINCIPLES } from "./worker-principles.ts";

const CALL_TOOL = "call";
const UNAVAILABLE_WORKER_TOOLS = new Set(["finish_call", "return", "herdr-fork"]);
const CALL_RUNTIME_CUSTOM_TYPE = "pi-herdr:call-runtime";
const TOOL_CONTROL_EVENT = "pi-ant:tool-control-changed";

const callParams = Type.Object({
  task: Type.String({
    minLength: 1,
    description: "Task to complete in a forked Herdr call frame using the current conversation context.",
  }),
});

type CallParams = Static<typeof callParams>;

interface CallRuntimeState {
  id: string;
  task: string;
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
  retrospectiveMarkdownPath: string;
  sessionFile: string;
  sessionCommand: string;
  task: string;
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
  return tools.filter((tool) => tool !== CALL_TOOL && !UNAVAILABLE_WORKER_TOOLS.has(tool));
}

function parseCallRuntime(value: unknown): CallRuntimeState | undefined {
  if (!isRecord(value)) return undefined;
  const workerTools = stringArray(value.workerTools);
  if (
    typeof value.id !== "string" ||
    typeof value.task !== "string" ||
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

function uniqueTools(tools: string[]): string[] {
  return [...new Set(tools)];
}

function runtimeActiveTools(runtime: CallRuntimeState): string[] {
  return uniqueTools([...runtime.workerTools, CALL_TOOL]);
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

function callFrameInstructions(task: string): string {
  return [
    "You have stepped into a call frame. The parent has delegated the task below to this frame.",
    "Complete it here using the available tools. Do not call `call` merely to delegate the same task again; the parent's instruction to use `call` has already been fulfilled. Use nested `call` only for a genuinely separate subtask.",
    "When complete, return only the exact parent-facing result or blocker.",
    "",
    WORKER_DESIGN_PRINCIPLES,
    "",
    "Task:",
    task,
  ].join("\n");
}

function statusText(runtime: CallRuntimeState | undefined): string | undefined {
  return runtime ? "call:child" : undefined;
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

function captureWorkerTools(
  pi: ExtensionAPI,
  runtime: CallRuntimeState | undefined,
  delegatedRootTools: string[] | undefined,
): string[] {
  if (runtime) return stripControlTools(runtime.workerTools);
  return stripControlTools(delegatedRootTools ?? pi.getActiveTools());
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
    retrospectiveMarkdownPath: paths.retrospectiveMarkdownPath,
    sessionFile,
    sessionCommand: `pi --session ${sessionFile}`,
    task: params.task,
    status: "finished",
  };
}

export default function (pi: ExtensionAPI) {
  let currentRuntime: CallRuntimeState | undefined;
  let delegatedRootTools: string[] | undefined;

  pi.events.on(TOOL_CONTROL_EVENT, (value: unknown) => {
    if (!isRecord(value)) return;
    const delegated = stringArray(value.delegatedTools);
    delegatedRootTools = delegated ? stripControlTools(delegated) : undefined;
  });

  function resolveRuntime(ctx: ExtensionContext): CallRuntimeState | undefined {
    const runtime = getLatestCallRuntime(ctx);
    currentRuntime = runtime;
    return runtime;
  }

  function applyRuntimeTools(runtime: CallRuntimeState | undefined): void {
    if (runtime) pi.setActiveTools(runtimeActiveTools(runtime));
  }

  function updateUi(ctx: ExtensionContext, runtime: CallRuntimeState | undefined): void {
    const status = statusText(runtime);
    ctx.ui.setStatus("call", status ? ctx.ui.theme.fg("accent", status) : undefined);

    if (runtime) {
      ctx.ui.setWidget("call", [
        "Herdr call frame",
        `task: ${runtime.task.slice(0, 160)}${runtime.task.length > 160 ? "…" : ""}`,
      ]);
      return;
    }

    ctx.ui.setWidget("call", undefined);
  }

  function refresh(ctx: ExtensionContext): void {
    const runtime = resolveRuntime(ctx);
    applyRuntimeTools(runtime);
    updateUi(ctx, runtime);
  }

  async function startForkedCall(
    ctx: ExtensionContext,
    params: CallParams,
    toolCallId: string,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback | undefined,
  ): Promise<{ resultText: string; details: CallToolDetails }> {
    const parentSession = ctx.sessionManager.getSessionFile();
    if (!parentSession || !fs.existsSync(parentSession)) {
      throw new Error("Current session is not persisted; cannot fork a Herdr call frame.");
    }

    const callId = makeWorkerId();
    const requestedLockName = sanitizeWorkerName(`call-${callId}`);
    const paths = createWorkerArtifacts();
    try {
      writeWorkerRequest(paths, {
        id: callId,
        task: callFrameInstructions(params.task),
        resultPath: paths.resultPath,
        statusPath: paths.statusPath,
        closeWhenDone: true,
      });

      const targetCwd = ctx.cwd;
      const preCallLeafId = getPreCallLeafId(ctx, toolCallId);
      const parentRuntime = resolveRuntime(ctx);
      const workerTools = captureWorkerTools(pi, parentRuntime, delegatedRootTools);
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

      const started = await startHerdrPiPane(pi, {
        name: requestedLockName,
        cwd: targetCwd,
        sessionFile: childSessionFile,
        piArgs: getSubagentModelCliArgs(ctx),
        placement: "tab",
      }, signal);

      const actualLockName = started.paneId;
      await waitForWorkerReady(pi, actualLockName, 10_000, signal);
      await sendTextToPane(pi, actualLockName, `/worker-run ${paths.requestPath}`, true, signal);

      const { result, details } = await waitForWorkerResult(pi, {
        id: callId,
        actualLockName,
        requestedLockName,
        paths,
        sessionFile: childSessionFile,
        task: params.task,
        signal,
        onUpdate,
      });
      if (result.isError) throw new Error(appendWorkerMoreInfo(result.result, paths));

      return {
        resultText: formatWorkerResult(result),
        details: { ...createCallDetails(paths, callId, actualLockName, requestedLockName, childSessionFile, params), elapsedMs: details.elapsedMs },
      };
    } catch (error) {
      throw new Error(appendWorkerMoreInfo(error instanceof Error ? error.message : String(error), paths));
    }
  }

  pi.registerTool({
    name: CALL_TOOL,
    label: "Call",
    description: "Run one delegated task in a forked worker with the current conversation context. Call it alone in a turn because sibling tool results are not included. Returns the result and automatic retrospective; failures throw with recovery details.",
    parameters: callParams,
    renderCall: renderCallArgs,
    async execute(toolCallId, params: CallParams, signal, onUpdate, ctx) {
      const { resultText, details } = await startForkedCall(ctx, params, toolCallId, signal, onUpdate);
      return {
        content: [{ type: "text", text: resultText }],
        details,
      };
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    refresh(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    refresh(ctx);
  });

  pi.on("before_agent_start", async (event) => {
    if (!currentRuntime) return undefined;
    return {
      systemPrompt: `${event.systemPrompt}\n\nYou are inside a Herdr call frame. The current worker request is the task delegated by the parent. Complete that task in this frame and return its parent-facing result. Do not re-delegate the same task through call.`,
    };
  });
}
