import * as path from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { renderWorkerCall } from "../worker-call.ts";
import { collectHistoryItems, modelCliArgs, prepareFreshSession } from "../context.ts";
import { createWorkerArtifacts, formatWorkerResult, makeWorkerId, writeWorkerRequest } from "../worker-frame.ts";
import { runEphemeralWorker } from "../workers.ts";
import { createWorkerToolResolver } from "../worker-tools.ts";
import { WORKER_DESIGN_PRINCIPLES } from "../worker-principles.ts";

const freshHistoryParams = Type.Object({
  history: Type.Integer({ minimum: 0, description: "Number of recent conversational items to include. Counts user requests and direct assistant replies only; tool calls/results are omitted." }),
  prompt: Type.String({ minLength: 1, description: "Task to run in the fresh history worker." }),
});

export default function freshHistoryExtension(pi: ExtensionAPI): void {
  const workerTools = createWorkerToolResolver(pi);
  pi.on("session_shutdown", () => workerTools.dispose());
  pi.registerTool({
    name: "fresh-history",
    label: "Fresh History",
    description: "Run one task in an ephemeral fresh-context worker with recent user requests and direct assistant replies; tool activity is omitted. Fresh-history calls run serially. Use when a small excerpt is enough, not for full-context or persistent follow-up work. Returns the answer and automatic retrospective; failures throw with recovery details.",
    parameters: freshHistoryParams,
    executionMode: "sequential",
    renderCall: (args) => renderWorkerCall("fresh-history", args),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (!ctx.model) throw new Error("Current session has no selected model.");
      const items = collectHistoryItems(ctx.sessionManager.buildContextEntries(), params.history);
      const parentSession = ctx.sessionManager.getSessionFile();
      const task = [
        WORKER_DESIGN_PRINCIPLES,
        "The excerpt below contains only recent user requests and direct assistant replies; tool calls, tool results, and other history are omitted. Use it for orientation and inspect the current environment as needed.",
        `Recovery only: parent session ${parentSession ?? "(not persisted)"}; session root ${path.join(getAgentDir(), "sessions")}.`,
        "# Recent parent conversation",
        items.length ? items.map((item, index) => `## ${index + 1}. ${item.role === "user" ? "User request" : "Assistant reply"}\n\n${item.text}`).join("\n\n")
          : "(no recent user/direct-assistant history requested or available)",
        "# Task", params.prompt,
      ].join("\n\n");
      const id = makeWorkerId();
      const paths = createWorkerArtifacts();
      writeWorkerRequest(paths, {
        id, task, tools: workerTools.current(), model: { provider: ctx.model.provider, id: ctx.model.id }, thinkingLevel: pi.getThinkingLevel(),
        resultPath: paths.resultPath, statusPath: paths.statusPath, closeWhenDone: true,
      });
      const sessionFile = prepareFreshSession(ctx.cwd, "fresh-history", { id, requestedHistory: params.history, includedHistory: items.length, parentSession });
      const args = modelCliArgs(ctx.model, pi.getThinkingLevel());
      const output = await runEphemeralWorker(pi, {
        id, name: `history-${id}`, cwd: ctx.cwd, sessionFile, args, paths, task: params.prompt, signal, onUpdate,
      });
      return {
        content: [{ type: "text", text: formatWorkerResult(output.result) }],
        details: { ...output.details, args, parentSession, requestedHistory: params.history, includedHistory: items.length, result: output.result },
      };
    },
  });
}
