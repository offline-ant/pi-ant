import { clampThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { renderWorkerCall } from "../worker-call.ts";
import { renderWorkerResult } from "../worker-result.ts";
import { EPHEMERAL_WORKER_CONTEXTS, inheritContextWarningPercent, type EphemeralWorkerTool } from "../delegate-policy.ts";
import { prepareDelegateSession } from "../context.ts";
import { createDelegateAltController, delegateModelLabel, type DelegateModelPair } from "../delegate-alt.ts";
import { createCodemodeDelegateController } from "../codemode-delegate.ts";
import { createWorkerArtifacts, formatWorkerResult, makeWorkerId, writeWorkerRequest } from "../worker-frame.ts";
import { runEphemeralWorker } from "../workers.ts";
import { WORKER_SCOPE_RULE } from "../worker-scope.ts";
import { findWorkerRecord, WORKER_ENTRY, workerResumeCommand, workerResumeHint, workerSavedConversations, workerStoppedNotice, type WorkerRecord } from "../worker-resume.ts";
import { getHost } from "../host.ts";
import { formatRemoteLocation, parseRemoteTarget, remoteChildEnvironment, resolveRemoteLocation, sessionRemote, type RemoteLocation } from "../remote-session.ts";

const remoteParam = Type.Optional(Type.String({
  minLength: 1,
  description: "Run the worker's tools on this SSH host, user@host[:/abs/path] (default path: remote home). The worker's Pi, model and session stay local. Defaults to this session's remote host, if any.",
}));
const delegateParams = Type.Object({
  task: Type.String({ minLength: 1, description: "Complete brief: requirements, relevant context, and desired result." }),
  folder: Type.Optional(Type.String({ description: "Working directory; defaults to the current one. A path on the remote host when tools run remotely." })),
  remote: remoteParam,
  alt: Type.Optional(Type.Boolean({
    default: false,
    description: "Use the other configured model, or the first if the caller is outside the pair. Defaults to false (inherit the caller's model).",
  })),
}, { additionalProperties: false });
const doParams = Type.Object({
  task: Type.String({ minLength: 1, description: "Goal, scope, and desired result. Do not repeat established context." }),
  resume: Type.Optional(Type.String({
    minLength: 1,
    description: "Continue this stopped worker from this conversation, by name (for example do-abc123), instead of starting a new one. Cannot be combined with remote or a model choice.",
  })),
  remote: remoteParam,
  alt: delegateParams.properties.alt,
}, { additionalProperties: false });

export type DelegateParams = Static<typeof delegateParams>;
type WorkerParams = DelegateParams & { resume?: string };

const toolGuidance: Record<EphemeralWorkerTool, { label: string; description: string; snippet: string }> = {
  do: {
    label: "Do",
    description: "Execute part of the current task with this conversation's context. Give a brief goal; don't investigate merely to prepare the handoff. Prefer do for non-trivial work. Pass resume to continue a stopped worker.",
    snippet: "Execute part of the current task with the conversation's context (preferred)",
  },
  delegate: {
    label: "Delegate",
    description: "Assign a large standalone task using the target directory's project instructions, without this conversation. Give a complete brief. Rarely needed; prefer do.",
    snippet: "Assign a large standalone task with a complete brief (rare; prefer do)",
  },
  fresh_look: {
    label: "Fresh Look",
    description: "Review a self-contained question without this conversation or discovered project/global instructions. Include everything needed in the task.",
    snippet: "Review a self-contained question without conversation or project instructions",
  },
};
const concurrencyGuideline = "Batch independent do, delegate, and fresh_look calls; they run concurrently. Wait for results before dependent reads, edits, or checks. Workers share files, not each other's conversation.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Where a worker runs its tools: an explicit target, else this session's.
 * Resolved here so an unreachable host or missing folder fails before startup.
 */
async function workerRemoteLocation(params: WorkerParams, signal?: AbortSignal): Promise<RemoteLocation | undefined> {
  if (params.remote !== undefined) return resolveRemoteLocation(parseRemoteTarget(params.remote), params.folder, signal);
  const session = sessionRemote();
  if (!session) return undefined;
  const location = await session.location(signal);
  return params.folder === undefined ? location : resolveRemoteLocation({ destination: location.destination, path: location.cwd }, params.folder, signal);
}

function branchHasInheritContextWarning(ctx: ExtensionContext): boolean {
  return ctx.sessionManager.getBranch().some(
    (entry) => entry.type === "custom" && entry.customType === "pi-orchestration:inherit-context-warning",
  );
}

export default function delegateExtension(pi: ExtensionAPI): void {
  let inheritContextWarningWasReturned = false;
  let pair: DelegateModelPair | null = null;
  let codemodeEnabled = false;
  // Nested calls have no transcript entry. Follow Pi's explicit parent links to
  // the model-issued call, never infer ancestry from an opaque provider ID.
  const origins = new Map<string, { toolName: string; toolCallId: string }>();
  pi.on("tool_call", (event, ctx) => {
    if (Object.hasOwn(EPHEMERAL_WORKER_CONTEXTS, event.toolName)) {
      if (!codemode.refresh(ctx) && event.parentToolCallId !== undefined) {
        return { block: true, reason: "Codemode delegation is disabled. Enable /codemode-delegate or call the worker tool directly." };
      }
    }
    const origin = event.parentToolCallId === undefined
      ? { toolName: event.toolName, toolCallId: event.toolCallId }
      : origins.get(event.parentToolCallId);
    if (!origin) throw new Error("Cannot identify the parent tool call for nested delegation.");
    origins.set(event.toolCallId, origin);
  });
  pi.on("tool_execution_end", (event) => { origins.delete(event.toolCallId); });
  pi.on("agent_end", () => { origins.clear(); });

  function restoreWarningState(ctx: ExtensionContext): void {
    inheritContextWarningWasReturned = branchHasInheritContextWarning(ctx);
  }

  pi.on("session_start", async (_event, ctx) => {
    restoreWarningState(ctx);
    // Optional by default. Saved /tools selections restore explicit choices, and
    // /worker-run applies the caller's selected tools after startup.
    pi.setActiveTools(pi.getActiveTools().filter((name) => name !== "fresh_look"));
  });
  pi.on("session_tree", async (_event, ctx) => restoreWarningState(ctx));

  /** Prepares a fresh or forked session; resuming reuses a stored worker's instead. */
  async function newWorker(
    tool: EphemeralWorkerTool, id: string, toolCallId: string, params: WorkerParams, signal: AbortSignal | undefined, ctx: ExtensionContext,
  ): Promise<WorkerRecord> {
    const model = alternate.resolve(ctx, params.alt === true);
    const thinkingLevel = clampThinkingLevel(model, pi.getThinkingLevel());
    const origin = origins.get(toolCallId);
    if (!origin) throw new Error("Cannot identify the model-issued worker call.");
    const location = await workerRemoteLocation(params, signal);
    const remote = location && formatRemoteLocation(location);
    const prepared = prepareDelegateSession({ ...params, tool, remote }, ctx, origin, { model, thinkingLevel });
    return {
      name: `${tool}-${id}`, tool, ...prepared, ...location && { env: remoteChildEnvironment(location) }, ...remote && { remote },
      model: { provider: model.provider, id: model.id }, thinkingLevel,
    };
  }

  function register(): void {
    for (const tool of Object.keys(EPHEMERAL_WORKER_CONTEXTS) as EphemeralWorkerTool[]) {
      const context = EPHEMERAL_WORKER_CONTEXTS[tool];
      const guidance = toolGuidance[tool];
      const schema = tool === "do" ? doParams : delegateParams;
      const parameters = pair ? schema : Type.Omit(schema, ["alt"]);
      pi.registerTool({
        name: tool,
        label: guidance.label,
        ...(codemodeEnabled ? {} : { exposure: "model-only" as const }),
        description: guidance.description
          + (pair ? ` Models: ${pair.map(delegateModelLabel).join(" and ")}. Set alt=true to use the other model, or the first if the caller is outside the pair.` : ""),
        promptSnippet: guidance.snippet,
        promptGuidelines: [
          ...(tool === "do" ? ["Prefer do for non-trivial investigation, verification, review, and implementation within the current task. Give a brief goal; use delegate only occasionally for large, fully specified standalone assignments. Handle trivial work directly."] : []),
          concurrencyGuideline,
          ...(codemodeEnabled && tool === "do" ? ["From codemode, do inherits the conversation before the outer tool call, not script-local results; include those findings in task. Await workers and return or print their results."] : []),
        ],
        parameters,
        prepareArguments(args) {
          // Pi may strip undeclared fields. Reject them before validation so an
          // obsolete context/folder/alt request cannot silently change meaning.
          if (isRecord(args)) {
            for (const key of Object.keys(args)) {
              if (!Object.hasOwn(parameters.properties, key)) {
                throw new Error(`${tool} does not accept '${key}'.${key === "alt" ? " Configure /delegate-alt first." : ""}`);
              }
            }
            if (Object.hasOwn(args, "alt") && typeof args.alt !== "boolean") {
              throw new Error(`${tool} alt must be a boolean.`);
            }
            if (Object.hasOwn(args, "remote")) parseRemoteTarget(String(args.remote));
            if (Object.hasOwn(args, "resume") && (Object.hasOwn(args, "alt") || Object.hasOwn(args, "remote"))) {
              throw new Error("resume continues a stored worker with its own model and target; it cannot be combined with alt or remote.");
            }
          }
          return args as WorkerParams;
        },
        executionMode: "parallel",
        renderCall: (args) => renderWorkerCall(tool, args),
        renderResult: renderWorkerResult,
        async execute(toolCallId, params: WorkerParams, signal, onUpdate, ctx) {
          const host = getHost(pi);
          const stored = params.resume === undefined ? undefined : findWorkerRecord(ctx.sessionManager.getBranch(), params.resume);
          if (params.resume !== undefined && !stored) {
            throw new Error(`Unknown worker '${params.resume}': no worker with that name was started on this conversation branch.`);
          }
          const warningPercent = stored ? undefined : inheritContextWarningPercent(context, ctx.getContextUsage()?.percent, inheritContextWarningWasReturned);
          if (warningPercent !== undefined) {
            inheritContextWarningWasReturned = true;
            // Nested results are not transcript entries; persist branch state directly.
            pi.appendEntry("pi-orchestration:inherit-context-warning", {});
            return {
              content: [{
                type: "text",
                text: `do not started: this conversation uses ${warningPercent.toFixed(1)}% of Pi's reported context window. Retry do to proceed, or use delegate with a complete brief. This warning is shown once per conversation branch.`,
              }],
              details: { inheritContextWarning: true, contextPercent: warningPercent },
            };
          }

          const id = makeWorkerId();
          const worker = stored ?? await newWorker(tool, id, toolCallId, params, signal, ctx);
          const { name, cwd, sessionFile, sessionId, args, env, remote, model, thinkingLevel } = worker;
          pi.appendEntry(WORKER_ENTRY, worker);
          const workerInfo = `Worker ${name}. Worker model: ${delegateModelLabel(model)}; thinking: ${thinkingLevel}.${remote ? ` Tools run on ${remote} over SSH.` : ""}`;
          // pi-deck offers Resume in Emacs; other hosts keep the human's shell recovery.
          const sessionCommand = host.kind === "emacs" ? undefined : workerResumeCommand(sessionFile, remote);
          const recovery = [workerStoppedNotice(name), ...sessionCommand === undefined ? [] : [workerResumeHint(sessionCommand)]].join("\n");
          const recoveryDetails = sessionCommand === undefined ? {} : { sessionCommand };
          // Lets frontends such as Pilish open the transcript read-only; details only, never content.
          const savedConversations = workerSavedConversations(sessionFile, sessionId, name);
          // Publish before native startup can block.
          onUpdate?.({
            content: [{ type: "text", text: `${workerInfo}\nStarting worker.` }],
            details: { sessionFile, ...recoveryDetails, savedConversations, cwd, ...remote && { remote }, status: "starting" },
          });
          try {
            const paths = createWorkerArtifacts();
            const tools = [...new Set([...pi.getActiveTools(), "do"])];
            writeWorkerRequest(paths, {
              id,
              task: [stored
                ? "Continue your existing work in this conversation, following the task below. Use nested do calls only for genuinely separate subtasks; do not forward the whole assignment."
                : tool === "do"
                  ? "Complete the task below using the existing conversation. Use nested do calls only for genuinely separate subtasks; do not forward the whole assignment."
                  : "", WORKER_SCOPE_RULE,
                tools.includes("self_compact") ? "Use self_compact only when substantial work remains; never to wrap up." : "",
                "Task:", params.task].filter(Boolean).join("\n\n"),
              tools,
              model: { provider: model.provider, id: model.id },
              thinkingLevel,
              resultPath: paths.resultPath,
              statusPath: paths.statusPath,
            });
            const output = await runEphemeralWorker(pi, {
              id, name, cwd, sessionFile, args, ...env && { env }, paths, task: params.task, signal,
              onUpdate: onUpdate ? (update) => onUpdate({
                ...update, content: [{ type: "text", text: workerInfo }, ...update.content],
                details: { ...update.details, ...recoveryDetails, savedConversations },
              }) : undefined,
            });
            return {
              content: [{ type: "text", text: `${workerInfo}\n\n${formatWorkerResult(output.result)}` }],
              details: { ...output.details, context: EPHEMERAL_WORKER_CONTEXTS[worker.tool], cwd, ...remote && { remote }, result: output.result,
                model, thinkingLevel, alt: params.alt === true, args, ...recoveryDetails, savedConversations },
            };
          } catch (error) {
            // Throwing preserves Pi's isError flag, including parent Escape.
            // Error details are discarded by Pi; keep recovery in model-visible text.
            throw new Error(`${recovery}\n\n${workerInfo}\n${error instanceof Error ? error.message : String(error)}`);
          }
        },
      });
    }
  }
  function reregister(): void {
    const activeTools = pi.getActiveTools();
    register();
    pi.setActiveTools(activeTools);
  }
  register();
  const alternate = createDelegateAltController(pi, (next) => {
    pair = next;
    reregister();
  });
  const codemode = createCodemodeDelegateController(pi, (enabled) => {
    codemodeEnabled = enabled;
    reregister();
  });
}
