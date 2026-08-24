import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import {
  DELEGATE_CONTEXTS,
  inheritContextWarningPercent,
} from "./delegate-policy.ts";
import { createDelegateRunner } from "./delegate-runner.ts";

const delegateParams = Type.Object({
  task: Type.String({
    minLength: 1,
    description: "Task to complete in one ephemeral delegated worker. For project/clean context, include all required conversation-specific context in this task.",
  }),
  context: StringEnum(DELEGATE_CONTEXTS, {
    description:
      "Required context mode. 'inherit' forks the current conversation before this call. 'project' starts a blank conversation with normal project/global resources but no conversation history. 'clean' starts a blank conversation without discovered instructions, skills, prompts, or extensions.",
  }),
  folder: Type.Optional(Type.String({
    description: "Working directory. Defaults to the current directory. Inherit permits the current directory only; use project/clean to change it.",
  })),
});

export type DelegateParams = Static<typeof delegateParams>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function branchHasInheritContextWarning(ctx: ExtensionContext): boolean {
  return ctx.sessionManager.getBranch().some(
    (entry) => entry.type === "message"
      && entry.message.role === "toolResult"
      && entry.message.toolName === "delegate"
      && isRecord(entry.message.details)
      && entry.message.details.inheritContextWarning === true,
  );
}

function renderDelegateArgs(args: DelegateParams) {
  const payload = JSON.stringify(args, null, 2) ?? String(args);
  const lines = ["delegate(", ...payload.split("\n").map((line) => `  ${line}`), ")"];
  return {
    render: (contentWidth: number) => lines.flatMap((line) => wrapTextWithAnsi(line, contentWidth)),
    invalidate: () => {
      /* no-op */
    },
  };
}

export default function delegateExtension(pi: ExtensionAPI): void {
  const runner = createDelegateRunner(pi);
  let inheritContextWarningWasReturned = false;

  function restoreWarningState(ctx: ExtensionContext): void {
    inheritContextWarningWasReturned = branchHasInheritContextWarning(ctx);
  }

  pi.on("session_start", async (_event, ctx) => restoreWarningState(ctx));
  pi.on("session_tree", async (_event, ctx) => restoreWarningState(ctx));

  pi.registerTool({
    name: "delegate",
    label: "Delegate",
    description: "Run one task in an ephemeral Herdr worker and wait for its result and automatic retrospective. A delegate-only sibling batch runs concurrently, then joins before the parent continues. context='inherit' continues from the current conversation and excludes the delegate call itself and sibling results; context='project' or 'clean' starts a blank conversation. context is required. Failures throw with recovery details.",
    promptSnippet: "Run an ephemeral task with inherited, project, or clean context",
    promptGuidelines: [
      "Use delegate with context='inherit' when the task depends on context established in the current conversation. Use context='project' for a self-contained task that needs normal project guidance but no conversation history; include all relevant requirements, decisions, paths, findings, and constraints in task. Use context='clean' for independent fresh-eyes work.",
      "For independent, non-overlapping tasks, issue a delegate-only sibling batch. Its calls execute concurrently and join before the parent continues; sibling results are not visible inside inherited delegates.",
    ],
    parameters: delegateParams,
    executionMode: "parallel",
    renderCall: renderDelegateArgs,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const warningPercent = inheritContextWarningPercent(
        params.context,
        ctx.getContextUsage()?.percent,
        inheritContextWarningWasReturned,
      );
      if (warningPercent !== undefined) {
        inheritContextWarningWasReturned = true;
        return {
          content: [{
            type: "text",
            text: `Delegate not started: this conversation uses ${warningPercent.toFixed(1)}% of its context window. Prefer context='project' with a self-contained task unless the worker requires the conversation history. Retry with context='inherit' to proceed; this warning is shown once per conversation branch.`,
          }],
          details: { inheritContextWarning: true, contextPercent: warningPercent },
        };
      }

      const output = params.context === "inherit"
        ? await runner.runInherited({
            task: params.task,
            context: "inherit",
            folder: params.folder,
          }, toolCallId, signal, onUpdate, ctx)
        : await runner.runFresh({
            task: params.task,
            context: params.context,
            folder: params.folder,
          }, signal, onUpdate, ctx);
      return {
        content: [{ type: "text", text: output.text }],
        details: output.details,
      };
    },
  });
}
