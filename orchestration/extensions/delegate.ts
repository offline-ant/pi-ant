import { clampThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { renderWorkerCall } from "../worker-call.ts";
import { EPHEMERAL_WORKER_CONTEXTS, inheritContextWarningPercent, type EphemeralWorkerTool } from "../delegate-policy.ts";
import { prepareDelegateSession } from "../context.ts";
import { createDelegateAltController, delegateModelLabel, type DelegateModelPair } from "../delegate-alt.ts";
import { createWorkerArtifacts, formatWorkerResult, makeWorkerId, writeWorkerRequest } from "../worker-frame.ts";
import { runEphemeralWorker } from "../workers.ts";
import { WORKER_DESIGN_PRINCIPLES } from "../worker-principles.ts";
import { workerResumeCommand, workerResumeHint } from "../worker-resume.ts";

const delegateParams = Type.Object({
  task: Type.String({ minLength: 1, description: "Complete brief: requirements, relevant context, and desired result." }),
  folder: Type.Optional(Type.String({ description: "Working directory; defaults to the current one." })),
  alt: Type.Optional(Type.Boolean({
    default: false,
    description: "Use the other configured model for a second opinion. Defaults to false.",
  })),
}, { additionalProperties: false });
const doParams = Type.Object({
  task: Type.String({ minLength: 1, description: "Goal, scope, and desired result. Do not repeat established context." }),
  alt: delegateParams.properties.alt,
}, { additionalProperties: false });

export type DelegateParams = Static<typeof delegateParams>;

const toolGuidance: Record<EphemeralWorkerTool, { label: string; description: string; snippet: string }> = {
  do: {
    label: "Do",
    description: "Execute part of the current task with this conversation's context. Give a brief goal; don't investigate merely to prepare the handoff. Prefer do for non-trivial work.",
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

function branchHasInheritContextWarning(ctx: ExtensionContext): boolean {
  return ctx.sessionManager.getBranch().some(
    (entry) => entry.type === "message"
      && entry.message.role === "toolResult"
      && entry.message.toolName === "do"
      && isRecord(entry.message.details)
      && entry.message.details.inheritContextWarning === true,
  );
}

export default function delegateExtension(pi: ExtensionAPI): void {
  let inheritContextWarningWasReturned = false;

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

  function register(pair: DelegateModelPair | null): void {
    for (const tool of Object.keys(EPHEMERAL_WORKER_CONTEXTS) as EphemeralWorkerTool[]) {
      const context = EPHEMERAL_WORKER_CONTEXTS[tool];
      const guidance = toolGuidance[tool];
      const schema = tool === "do" ? doParams : delegateParams;
      const parameters = pair ? schema : Type.Omit(schema, ["alt"]);
      pi.registerTool({
        name: tool,
        label: guidance.label,
        description: guidance.description
          + (pair ? ` Models: ${pair.map(delegateModelLabel).join(" and ")}. Set alt=true to use the other model.` : ""),
        promptSnippet: guidance.snippet,
        promptGuidelines: [
          ...(tool === "do" ? ["Prefer do for non-trivial investigation, verification, review, and implementation within the current task. Give a brief goal; use delegate only occasionally for large, fully specified standalone assignments. Handle trivial work directly."] : []),
          concurrencyGuideline,
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
          }
          return args as DelegateParams;
        },
        executionMode: "parallel",
        renderCall: (args) => renderWorkerCall(tool, args),
        async execute(toolCallId, params: DelegateParams, signal, onUpdate, ctx) {
          const model = alternate.resolve(ctx, params.alt === true);
          const thinkingLevel = clampThinkingLevel(model, pi.getThinkingLevel());
          const modelInfo = `Worker model: ${delegateModelLabel(model)}; thinking: ${thinkingLevel}.`;
          const warningPercent = inheritContextWarningPercent(context, ctx.getContextUsage()?.percent, inheritContextWarningWasReturned);
          if (warningPercent !== undefined) {
            inheritContextWarningWasReturned = true;
            return {
              content: [{
                type: "text",
                text: `do not started: this conversation uses ${warningPercent.toFixed(1)}% of Pi's reported context window. Retry do to proceed, or use delegate with a complete brief. This warning is shown once per conversation branch.`,
              }],
              details: { inheritContextWarning: true, contextPercent: warningPercent },
            };
          }

          const prepared = prepareDelegateSession({ ...params, tool }, ctx, toolCallId, { model, thinkingLevel });
          const sessionCommand = workerResumeCommand(prepared.sessionFile);
          const resumeHint = workerResumeHint(sessionCommand);
          // Publish before native startup or its first output capture can block.
          onUpdate?.({
            content: [{ type: "text", text: `${resumeHint}\n\n${modelInfo}\nStarting worker.` }],
            details: { sessionFile: prepared.sessionFile, sessionCommand, cwd: prepared.cwd, status: "starting" },
          });
          try {
            const id = makeWorkerId();
            const paths = createWorkerArtifacts();
            const tools = [...new Set([...pi.getActiveTools(), "do"])];
            writeWorkerRequest(paths, {
              id,
              task: [tool === "do"
                ? "Complete the task below using the existing conversation. Use nested do calls only for genuinely separate subtasks; do not forward the whole assignment."
                : "", WORKER_DESIGN_PRINCIPLES,
                tools.includes("self_compact") ? "Use self_compact only when substantial work remains; never to wrap up." : "",
                "Task:", params.task].filter(Boolean).join("\n\n"),
              tools,
              model: { provider: model.provider, id: model.id },
              thinkingLevel,
              resultPath: paths.resultPath,
              statusPath: paths.statusPath,
            });
            const output = await runEphemeralWorker(pi, {
              ...prepared, id, name: `${tool}-${id}`, paths, task: params.task, signal,
              onUpdate: onUpdate ? (update) => onUpdate({
                ...update, content: [{ type: "text", text: `${resumeHint}\n\n${modelInfo}` }, ...update.content],
                details: { ...update.details, sessionCommand },
              }) : undefined,
            });
            return {
              content: [{ type: "text", text: `${resumeHint}\n\n${modelInfo}\n\n${formatWorkerResult(output.result)}` }],
              details: { ...output.details, context, cwd: prepared.cwd, result: output.result,
                model: { provider: model.provider, id: model.id }, thinkingLevel, alt: params.alt === true,
                args: prepared.args, sessionCommand },
            };
          } catch (error) {
            // Throwing preserves Pi's isError flag, including parent Escape.
            // Error details are discarded by Pi; keep recovery in model-visible text.
            throw new Error(`${resumeHint}\n\n${modelInfo}\n${error instanceof Error ? error.message : String(error)}`);
          }
        },
      });
    }
  }
  register(null);
  const alternate = createDelegateAltController(pi, (pair) => {
    const activeTools = pi.getActiveTools();
    register(pair);
    pi.setActiveTools(activeTools);
  });
}
