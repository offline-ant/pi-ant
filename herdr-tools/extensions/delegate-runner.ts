import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { SessionManager, type AgentToolUpdateCallback, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { cleanContextCliArgs, withoutDelegateTool, type DelegateContext } from "./delegate-policy.ts";
import { closePane, flushSessionFile, resolveCwd, sendTextToPane, startHerdrPiPane } from "./herdr-helpers.ts";
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
  type WorkerResultFile,
} from "./worker-frame.ts";
import { WORKER_DESIGN_PRINCIPLES } from "./worker-principles.ts";

const DELEGATE_TOOL = "delegate";
const DELEGATE_RUNTIME_CUSTOM_TYPE = "pi-herdr:delegate-runtime";
const FRESH_DELEGATE_CUSTOM_TYPE = "pi-herdr:delegate";
const TOOL_CONTROL_EVENT = "pi-ant:tool-control-changed";
const WORKER_FRAME_EXTENSION_PATH = fileURLToPath(new URL("./worker-frame.ts", import.meta.url));

export interface DelegateRequest {
  task: string;
  context: DelegateContext;
  folder?: string;
}

interface DelegateRuntimeState {
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
  customType?: string;
  data?: unknown;
}

export interface DelegateRunDetails {
  id: string;
  context: DelegateContext;
  cwd: string;
  lockName: string;
  requestedLockName: string;
  sessionFile: string;
  sessionCommand: string;
  task: string;
  args: string[];
  result: WorkerResultFile;
  artifacts: WorkerArtifactPaths;
  elapsedMs?: number;
  status: "finished";
}

export interface DelegateRunOutput {
  text: string;
  details: DelegateRunDetails;
}

interface DelegateRunner {
  runInherited(
    request: DelegateRequest & { context: "inherit" },
    toolCallId: string,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback | undefined,
    ctx: ExtensionContext,
  ): Promise<DelegateRunOutput>;
  runFresh(
    request: DelegateRequest & { context: "project" | "clean" },
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback | undefined,
    ctx: ExtensionContext,
  ): Promise<DelegateRunOutput>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.every((item) => typeof item === "string") ? value : undefined;
}

function parseDelegateRuntime(value: unknown): DelegateRuntimeState | undefined {
  if (!isRecord(value)) return undefined;
  const workerTools = stringArray(value.workerTools);
  if (
    typeof value.id !== "string"
    || typeof value.task !== "string"
    || typeof value.parentSession !== "string"
    || typeof value.childSession !== "string"
    || typeof value.parentCwd !== "string"
    || typeof value.childCwd !== "string"
    || typeof value.lockName !== "string"
    || workerTools === undefined
    || typeof value.createdAt !== "string"
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
    workerTools: withoutDelegateTool(workerTools),
    createdAt: value.createdAt,
  };
}

function getLatestDelegateRuntime(ctx: ExtensionContext): DelegateRuntimeState | undefined {
  const entries: CustomStateEntryLike[] = ctx.sessionManager.getBranch().filter(
    (entry): entry is typeof entry & { customType: string } => entry.type === "custom" && typeof entry.customType === "string",
  );
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.customType !== DELEGATE_RUNTIME_CUSTOM_TYPE) continue;
    const runtime = parseDelegateRuntime(entry.data);
    if (runtime) return runtime;
  }
  return undefined;
}

function getPreDelegateLeafId(ctx: ExtensionContext, toolCallId: string): string | null {
  const branch = ctx.sessionManager.getBranch();
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    const hasThisCall = entry.message.content.some(
      (item) => isRecord(item) && item.type === "toolCall" && item.id === toolCallId && item.name === DELEGATE_TOOL,
    );
    if (hasThisCall) return entry.parentId ?? null;
  }

  throw new Error("Could not identify this delegate tool call in the current session branch; refusing to fork an unmatched transcript.");
}

function inheritedTaskPrompt(task: string): string {
  return [
    "You are inside an inherited delegate frame. The parent delegated the task below from its current conversation.",
    "Complete it here using the available tools. Do not call `delegate` merely to re-delegate the same task; use nested delegation only for a genuinely separate subtask.",
    "",
    WORKER_DESIGN_PRINCIPLES,
    "",
    "Task:",
    task,
  ].join("\n");
}

function freshTaskPrompt(task: string): string {
  return [WORKER_DESIGN_PRINCIPLES, "", "Task:", task].join("\n");
}

function makeRunDetails(options: {
  id: string;
  context: DelegateContext;
  cwd: string;
  actualLockName: string;
  requestedLockName: string;
  sessionFile: string;
  task: string;
  args: string[];
  result: WorkerResultFile;
  paths: WorkerArtifactPaths;
  elapsedMs?: number;
}): DelegateRunDetails {
  return {
    id: options.id,
    context: options.context,
    cwd: options.cwd,
    lockName: options.actualLockName,
    requestedLockName: options.requestedLockName,
    sessionFile: options.sessionFile,
    sessionCommand: `pi --session ${options.sessionFile}`,
    task: options.task,
    args: options.args,
    result: options.result,
    artifacts: options.paths,
    elapsedMs: options.elapsedMs,
    status: "finished",
  };
}

export function createDelegateRunner(pi: ExtensionAPI): DelegateRunner {
  let currentRuntime: DelegateRuntimeState | undefined;
  let delegatedRootTools: string[] | undefined;

  const unsubscribeToolControl = pi.events.on(TOOL_CONTROL_EVENT, (value: unknown) => {
    if (!isRecord(value)) return;
    const delegated = stringArray(value.delegatedTools);
    delegatedRootTools = delegated ? withoutDelegateTool(delegated) : undefined;
  });

  function resolveRuntime(ctx: ExtensionContext): DelegateRuntimeState | undefined {
    const runtime = getLatestDelegateRuntime(ctx);
    currentRuntime = runtime;
    return runtime;
  }

  function refreshRuntime(ctx: ExtensionContext): void {
    const runtime = resolveRuntime(ctx);
    if (runtime) {
      pi.setActiveTools([...new Set([...runtime.workerTools, DELEGATE_TOOL])]);
      ctx.ui.setStatus("delegate", ctx.ui.theme.fg("accent", "delegate:child"));
      ctx.ui.setWidget("delegate", [
        "Herdr inherited delegate",
        `task: ${runtime.task.slice(0, 160)}${runtime.task.length > 160 ? "…" : ""}`,
      ]);
      return;
    }

    ctx.ui.setStatus("delegate", undefined);
    ctx.ui.setWidget("delegate", undefined);
  }

  pi.on("session_start", async (_event, ctx) => refreshRuntime(ctx));
  pi.on("session_tree", async (_event, ctx) => refreshRuntime(ctx));
  pi.on("session_shutdown", async () => unsubscribeToolControl());

  async function runInheritedAttempt(
    request: DelegateRequest & { context: "inherit" },
    parentSession: string,
    workerTools: string[],
    args: string[],
    toolCallId: string,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback | undefined,
    ctx: ExtensionContext,
  ): Promise<DelegateRunOutput> {
    const id = makeWorkerId();
    const requestedLockName = sanitizeWorkerName(`delegate-${id}`);
    const paths = createWorkerArtifacts();
    let actualLockName = "";
    try {
      writeWorkerRequest(paths, {
        id,
        task: inheritedTaskPrompt(request.task),
        resultPath: paths.resultPath,
        statusPath: paths.statusPath,
        closeWhenDone: true,
      });

      const forked = SessionManager.forkFrom(parentSession, ctx.cwd);
      const childSessionFile = forked.getSessionFile();
      if (!childSessionFile) throw new Error("Could not create a persistent session for inherited delegate.");

      const preDelegateLeafId = getPreDelegateLeafId(ctx, toolCallId);
      if (preDelegateLeafId === null) forked.resetLeaf();
      else forked.branch(preDelegateLeafId);

      const runtime: DelegateRuntimeState = {
        id,
        task: request.task,
        parentSession,
        childSession: childSessionFile,
        parentCwd: ctx.cwd,
        childCwd: ctx.cwd,
        lockName: requestedLockName,
        workerTools,
        createdAt: new Date().toISOString(),
      };
      forked.appendCustomEntry(DELEGATE_RUNTIME_CUSTOM_TYPE, runtime);
      flushSessionFile(forked, childSessionFile);

      const started = await startHerdrPiPane(pi, {
        name: requestedLockName,
        cwd: ctx.cwd,
        sessionFile: childSessionFile,
        piArgs: args,
        placement: "tab",
      }, signal);
      actualLockName = started.paneId;

      await waitForWorkerReady(pi, actualLockName, 10_000, signal);
      await sendTextToPane(pi, actualLockName, `/worker-run ${paths.requestPath}`, true, signal);
      const { result, details } = await waitForWorkerResult(pi, {
        id,
        actualLockName,
        requestedLockName,
        paths,
        sessionFile: childSessionFile,
        task: request.task,
        signal,
        onUpdate,
      });
      if (result.isError) throw new Error(result.result);

      return {
        text: formatWorkerResult(result),
        details: makeRunDetails({
          id,
          context: "inherit",
          cwd: ctx.cwd,
          actualLockName,
          requestedLockName,
          sessionFile: childSessionFile,
          task: request.task,
          args,
          result,
          paths,
          elapsedMs: details.elapsedMs,
        }),
      };
    } catch (error) {
      throw new Error(appendWorkerMoreInfo(error instanceof Error ? error.message : String(error), paths));
    } finally {
      if (actualLockName) await closePane(pi, actualLockName).catch(() => undefined);
    }
  }

  async function runInherited(
    request: DelegateRequest & { context: "inherit" },
    toolCallId: string,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback | undefined,
    ctx: ExtensionContext,
  ): Promise<DelegateRunOutput> {
    const inheritedCwd = resolveCwd(ctx.cwd, request.folder);
    if (inheritedCwd !== path.resolve(ctx.cwd)) {
      throw new Error("Inherited delegates cannot change the parent working directory. Use context='project' for a fresh worker in another folder.");
    }

    const parentSession = ctx.sessionManager.getSessionFile();
    if (!parentSession || !fs.existsSync(parentSession)) {
      throw new Error("Current session is not persisted; cannot start an inherited delegate.");
    }

    const parentRuntime = resolveRuntime(ctx);
    const workerTools = parentRuntime
      ? withoutDelegateTool(parentRuntime.workerTools)
      : withoutDelegateTool(delegatedRootTools ?? pi.getActiveTools());
    if (workerTools.length === 0) {
      throw new Error("Cannot start inherited delegate: no worker tools remain after stripping delegation control tools.");
    }

    return runInheritedAttempt(
      request,
      parentSession,
      workerTools,
      getSubagentModelCliArgs(ctx),
      toolCallId,
      signal,
      onUpdate,
      ctx,
    );
  }

  async function runFreshWorker(
    request: DelegateRequest & { context: "project" | "clean" },
    cwd: string,
    args: string[],
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback | undefined,
  ): Promise<DelegateRunOutput> {
    const id = makeWorkerId();
    const paths = createWorkerArtifacts();
    writeWorkerRequest(paths, {
      id,
      task: freshTaskPrompt(request.task),
      resultPath: paths.resultPath,
      statusPath: paths.statusPath,
      closeWhenDone: true,
    });

    const session = SessionManager.create(cwd);
    const sessionFile = session.getSessionFile();
    if (!sessionFile) {
      throw new Error(appendWorkerMoreInfo("Could not create a persistent session for fresh delegate.", paths));
    }
    session.appendCustomEntry(FRESH_DELEGATE_CUSTOM_TYPE, {
      id,
      context: request.context,
      createdAt: new Date().toISOString(),
    });
    flushSessionFile(session, sessionFile);

    const requestedLockName = sanitizeWorkerName(`delegate-${path.basename(cwd)}-${id}`);
    let actualLockName = "";
    try {
      const started = await startHerdrPiPane(pi, {
        name: requestedLockName,
        cwd,
        sessionFile,
        piArgs: args,
        placement: "tab",
      }, signal);
      actualLockName = started.paneId;

      await waitForWorkerReady(pi, actualLockName, 10_000, signal);
      await sendTextToPane(pi, actualLockName, `/worker-run ${paths.requestPath}`, true, signal);
      const { result, details } = await waitForWorkerResult(pi, {
        id,
        actualLockName,
        requestedLockName,
        paths,
        sessionFile,
        task: request.task,
        signal,
        onUpdate,
      });
      if (result.isError) throw new Error(result.result);

      return {
        text: formatWorkerResult(result),
        details: makeRunDetails({
          id,
          context: request.context,
          cwd,
          actualLockName,
          requestedLockName,
          sessionFile,
          task: request.task,
          args,
          result,
          paths,
          elapsedMs: details.elapsedMs,
        }),
      };
    } catch (error) {
      throw new Error(appendWorkerMoreInfo(error instanceof Error ? error.message : String(error), paths));
    } finally {
      if (actualLockName) await closePane(pi, actualLockName).catch(() => undefined);
    }
  }

  async function runFresh(
    request: DelegateRequest & { context: "project" | "clean" },
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback | undefined,
    ctx: ExtensionContext,
  ): Promise<DelegateRunOutput> {
    const cwd = resolveCwd(ctx.cwd, request.folder);
    const args = [
      ...getSubagentModelCliArgs(ctx),
      ...cleanContextCliArgs(request.context, WORKER_FRAME_EXTENSION_PATH),
    ];
    return runFreshWorker(request, cwd, args, signal, onUpdate);
  }

  return { runInherited, runFresh };
}
