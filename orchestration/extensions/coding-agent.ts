import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { renderWorkerCall } from "../worker-call.ts";
import { modelCliArgs, prepareFreshSession, resolveCwd } from "../context.ts";
import { getHost, hostForTarget } from "../host.ts";
import { appendWorkerMoreInfo, createWorkerArtifacts, formatWorkerResult, makeWorkerId, readWorkerStatus, writeWorkerRequest, type WorkerArtifactPaths } from "../worker-frame.ts";
import { claimName, readPersistentWorker, removeTarget, savePersistentWorker, validateName, waitForWorkerResult, type PersistentWorker } from "../workers.ts";
import { createWorkerToolResolver } from "../worker-tools.ts";
import { WORKER_DESIGN_PRINCIPLES } from "../worker-principles.ts";

const codingAgentParams = Type.Object({
  name: Type.String({ description: "Name of the persistent fresh-context worker." }),
  task: Type.String({ minLength: 1, description: "Task to run in the coding agent." }),
  folder: Type.Optional(Type.String({ description: "Working directory. Defaults to the current working directory." })),
});

export default function codingAgentExtension(pi: ExtensionAPI): void {
  const workerTools = createWorkerToolResolver(pi);
  pi.on("session_shutdown", () => workerTools.dispose());
  pi.registerTool({
    name: "coding-agent",
    label: "Coding Agent",
    description: "Run one task in a named persistent fresh-context worker and wait for completion. The worker remains available by name for follow-ups. Sibling calls with different worker names can run concurrently. Returns its result, automatic retrospective, idle status, and context use; failures throw with recovery details. Cancellation closes owned work while retaining its session file.",
    parameters: codingAgentParams,
    executionMode: "parallel",
    renderCall: (args) => renderWorkerCall("coding-agent", args),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const name = validateName(params.name);
      const cwd = resolveCwd(ctx.cwd, params.folder);
      if (!ctx.model) throw new Error("Current session has no selected model.");
      const release = claimName(name);
      let paths: WorkerArtifactPaths | undefined;
      let worker: PersistentWorker | undefined;
      let ownsRequest = false;
      try {
        worker = readPersistentWorker(name);
        if (worker) {
          if (path.resolve(worker.cwd) !== cwd) throw new Error(`coding-agent '${name}' already exists for ${worker.cwd}; refusing reuse with ${cwd}.`);
          const host = hostForTarget(pi, worker.target);
          if (await host.state(worker.target, signal) !== "running") {
            await host.close(worker.target);
            removeTarget(name);
            worker = undefined;
          } else {
            const status = readWorkerStatus(worker.statusPath);
            if (!status || status.state !== "idle") throw new Error(`coding-agent '${name}' is busy or has no settled status.`);
          }
        }
        const id = makeWorkerId();
        paths = createWorkerArtifacts();
        writeWorkerRequest(paths, {
          id, task: `${WORKER_DESIGN_PRINCIPLES}\n\nTask:\n${params.task}`, tools: workerTools.current(),
          model: { provider: ctx.model.provider, id: ctx.model.id }, thinkingLevel: pi.getThinkingLevel(),
          resultPath: paths.resultPath, statusPath: paths.statusPath, closeWhenDone: false,
        });
        if (!worker) {
          const sessionFile = prepareFreshSession(cwd, "coding-agent", { name, cwd, createdAt: new Date().toISOString() });
          const host = getHost(pi);
          const target = await host.start({
            kind: "pi", name, cwd, sessionFile, args: modelCliArgs(ctx.model, pi.getThinkingLevel()),
            prompt: `/worker-run ${paths.requestPath}`, placement: "worker", parent: host.parent(),
          }, signal);
          ownsRequest = true;
          worker = { target, cwd, sessionFile, statusPath: paths.statusPath };
          savePersistentWorker(worker);
        } else {
          worker = { ...worker, statusPath: paths.statusPath };
          savePersistentWorker(worker);
          ownsRequest = true;
          await hostForTarget(pi, worker.target).send(worker.target, { kind: "prompt", text: `/worker-run ${paths.requestPath}` }, signal);
        }
        const { result, details } = await waitForWorkerResult(pi, {
          id, target: worker.target, paths, sessionFile: worker.sessionFile, task: params.task, signal, onUpdate,
        });
        ownsRequest = false;
        if (result.isError) throw new Error(result.result);
        const context = result.contextPercent == null ? "unknown" : `${result.contextPercent.toFixed(1)}%`;
        return {
          content: [{ type: "text", text: `${formatWorkerResult(result).trimEnd()}\n\nWorker: ${name}; status: idle; context: ${context}.` }],
          details: { ...details, name, worker, result, sessionCommand: `pi --session ${worker.sessionFile}` },
        };
      } catch (error) {
        let message = error instanceof Error ? error.message : String(error);
        // An owned request with no matched completion must not continue unnoticed.
        if (worker && ownsRequest) {
          try {
            await hostForTarget(pi, worker.target).close(worker.target);
            removeTarget(name);
          } catch (closeError) {
            message += `\nCould not close worker ${name}: ${String(closeError)}`;
          }
        }
        throw new Error(paths ? appendWorkerMoreInfo(message, paths) : message);
      } finally {
        release();
      }
    },
  });
}
