import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { SessionManager, type AgentToolUpdateCallback, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { cleanContextCliArgs, withoutDelegateTool, type DelegateContext } from "./delegate-policy.ts";
import { closeHerdrAgent, flushSessionFile, getPreToolCallLeafId, modelCliArgs, promptHerdrAgent, resolveCwd, startHerdrPiAgent, workerAgentName } from "./herdr-helpers.ts";
import {
  appendWorkerMoreInfo,
  createWorkerArtifacts,
  formatWorkerResult,
  makeWorkerId,
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
  agentName: string;
  paneId: string;
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
  agentName: string;
  paneId: string;
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
    agentName: options.agentName,
    paneId: options.paneId,
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
    const agentName = workerAgentName("delegate", id);
    const paths = createWorkerArtifacts();
    let paneId = "";
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

      const preDelegateLeafId = getPreToolCallLeafId(ctx.sessionManager, DELEGATE_TOOL, toolCallId);
      if (preDelegateLeafId === null) forked.resetLeaf();
      else forked.branch(preDelegateLeafId);

      const runtime: DelegateRuntimeState = {
        id,
        task: request.task,
        parentSession,
        childSession: childSessionFile,
        parentCwd: ctx.cwd,
        childCwd: ctx.cwd,
        workerTools,
        createdAt: new Date().toISOString(),
      };
      forked.appendCustomEntry(DELEGATE_RUNTIME_CUSTOM_TYPE, runtime);
      flushSessionFile(forked, childSessionFile);

      const started = await startHerdrPiAgent(pi, {
        name: agentName,
        cwd: ctx.cwd,
        sessionFile: childSessionFile,
        piArgs: args,
      }, signal);
      paneId = started.paneId;

      await promptHerdrAgent(pi, agentName, `/worker-run ${paths.requestPath}`, signal);
      const { result, details } = await waitForWorkerResult(pi, {
        id,
        agentName,
        paneId,
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
          agentName,
          paneId,
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
      if (paneId) await closeHerdrAgent(pi, agentName, paneId).catch(() => undefined);
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
      modelCliArgs(ctx.model, pi.getThinkingLevel()),
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

    const agentName = workerAgentName("delegate", id);
    let paneId = "";
    try {
      const started = await startHerdrPiAgent(pi, {
        name: agentName,
        cwd,
        sessionFile,
        piArgs: args,
      }, signal);
      paneId = started.paneId;

      await promptHerdrAgent(pi, agentName, `/worker-run ${paths.requestPath}`, signal);
      const { result, details } = await waitForWorkerResult(pi, {
        id,
        agentName,
        paneId,
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
          agentName,
          paneId,
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
      if (paneId) await closeHerdrAgent(pi, agentName, paneId).catch(() => undefined);
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
      ...modelCliArgs(ctx.model, pi.getThinkingLevel()),
      ...cleanContextCliArgs(request.context, WORKER_FRAME_EXTENSION_PATH),
    ];
    return runFreshWorker(request, cwd, args, signal, onUpdate);
  }

  return { runInherited, runFresh };
}
