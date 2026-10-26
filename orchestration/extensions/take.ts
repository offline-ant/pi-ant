import type * as net from "node:net";
import * as path from "node:path";
import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { listTargets } from "../workers.ts";
import { agentDirectory, assertTransferIdle, saveTransfer, verifyTransfer, transferOperation, type SessionTransfer } from "../session-transfer.ts";
import { listTakeCandidates, listenTake, ownTakeSocket, requestTake, type TakeDescription, type TakeReply, type TakeRequest } from "../session-take.ts";

interface PendingRequest { request: TakeRequest; reply: TakeReply }
interface TakeState {
  server?: net.Server;
  socket?: string;
  dispatch?: (request: TakeRequest, reply: TakeReply) => void;
  report?: (message: string) => void;
  ready?: (transfer: SessionTransfer) => void;
  pending: Map<string, PendingRequest>;
  active?: { role: "source" } | { role: "receiver"; peer: string };
  replacing: boolean;
  restore?: SessionTransfer;
}
// Session replacement reloads extensions. Only this in-flight control operation
// survives; conversations and tools remain in the ordinary session file.
const TAKE_STATE = Symbol.for("pi-orchestration:session-take");
function takeState(): TakeState {
  const global = globalThis as typeof globalThis & { [TAKE_STATE]?: TakeState };
  return global[TAKE_STATE] ??= { pending: new Map(), replacing: false };
}

function frontend(ctx: ExtensionContext, env: NodeJS.ProcessEnv): "herdr" | "tau" | undefined {
  if (ctx.mode === "tui" && env.HERDR_ENV === "1") return "herdr";
  if (ctx.mode === "rpc" && env.PI_ORCHESTRATION_HOST === "web") return "tau";
  return undefined;
}

export function registerTake(pi: ExtensionAPI): void {
  const state = takeState();
  const idle = (ctx: ExtensionContext) => assertTransferIdle(pi, ctx, listTargets());
  const describe = (ctx: ExtensionContext): TakeDescription => {
    idle(ctx);
    const kind = frontend(ctx, process.env);
    if (!kind) throw new Error("Session takeover is available only in Herdr and Tau.");
    const file = ctx.sessionManager.getSessionFile();
    return { frontend: kind, sessionFile: file ? path.resolve(file) : null, cwd: ctx.cwd,
      agentDir: agentDirectory(process.env), name: ctx.sessionManager.getSessionName() || "Pi" };
  };

  pi.on("session_start", async (_event, ctx) => {
    if (!frontend(ctx, process.env)) return;
    state.report = message => ctx.ui.notify(message, "error");
    if (state.restore) {
      const transfer = state.restore;
      const model = ctx.modelRegistry.find(transfer.model.provider, transfer.model.id);
      if (!model || !await pi.setModel(model)) throw new Error("The taken session's model is unavailable in this Pi process.");
      pi.setThinkingLevel(transfer.thinking);
      state.restore = undefined;
    }
    state.ready = transfer => {
      idle(ctx);
      verifyTransfer(ctx, transfer);
      if (pi.getThinkingLevel() !== transfer.thinking || JSON.stringify([...pi.getActiveTools()].sort()) !== JSON.stringify([...transfer.tools].sort())) {
        throw new Error("The destination did not preserve the thinking level and tools.");
      }
    };
    state.dispatch = (request, reply) => {
      if (request.kind === "describe") {
        try {
          if (state.active?.role === "source") throw new Error("This session is already being transferred.");
          const description = describe(ctx);
          if (!description.sessionFile || !fs.existsSync(description.sessionFile)) throw new Error("This session is not persisted.");
          void reply(description).catch(() => {});
        } catch (error) { void reply(undefined, error instanceof Error ? error.message : String(error)).catch(() => {}); }
        return;
      }
      const token = randomUUID();
      state.pending.set(token, { request, reply });
      // Dispatch a registered command, never terminal text or a model prompt.
      try { pi.sendUserMessage(`/_session-take ${token}`, { expandPromptTemplates: true }); }
      catch (error) {
        state.pending.delete(token);
        void reply(undefined, error instanceof Error ? error.message : String(error)).catch(() => {});
      }
    };
    if (!state.server) {
      state.socket = ownTakeSocket(frontend(ctx, process.env)!, process.env);
      state.server = await listenTake(state.socket, (request, reply) => state.dispatch?.(request, reply));
    }
  });

  pi.on("session_shutdown", async event => {
    if (state.replacing && event.reason === "resume") return;
    state.dispatch = undefined;
    const server = state.server;
    state.server = undefined;
    state.active = undefined;
    state.restore = undefined;
    for (const pending of state.pending.values()) void pending.reply(undefined, "Pi closed before takeover completed.").catch(() => {});
    state.pending.clear();
    server?.close();
  });
  pi.on("input", (_event, ctx) => {
    if (!state.active) return;
    ctx.ui.notify("Session takeover is in progress; input was not submitted.", "warning");
    return { action: "handled" };
  });
  pi.on("session_before_switch", () => state.active && !state.replacing ? { cancel: true } : undefined);
  pi.on("session_before_tree", () => state.active ? { cancel: true } : undefined);
  pi.on("session_before_compact", () => state.active ? { cancel: true } : undefined);
  pi.on("cache_warming_decision", () => state.active ? { action: "stop" } : undefined);

  pi.registerCommand("_session-take", {
    description: "Private draft-safe session takeover dispatch",
    handler: async (token, ctx) => {
      const pending = state.pending.get(token.trim());
      if (!pending) { ctx.ui.notify("No matching session takeover request.", "error"); return; }
      state.pending.delete(token.trim());
      const { request, reply } = pending;
      let ownsSource = false;
      let sourceReady = false;
      try {
        if (request.kind === "take") {
          if (state.active || transferOperation().active) throw new Error("A session transfer is already in progress.");
          transferOperation().active = true;
          ownsSource = true;
          const source = describe(ctx);
          if (source.sessionFile !== request.sessionFile) throw new Error("The source conversation changed; select it again.");
          const transfer = saveTransfer(pi, ctx, process.env);
          state.active = { role: "source" };
          // The source remains loaded on failure, and exits after success. Unlike
          // /switch's retained source, it needs no same-file reload or restoration.
          const result = await requestTake<{ ready: boolean }>(request.receiver, {
            kind: "load", source: state.socket!, receiverSession: request.receiverSession, transfer,
          });
          if (!result.ready) throw new Error("The destination did not confirm readiness.");
          sourceReady = true;
          try { await reply({ taken: true }); }
          finally {
            // RPC checks ctx.shutdown only after stdin commands. This idle
            // socket request uses its orderly SIGTERM handler instead.
            if (ctx.mode === "rpc") process.kill(process.pid, "SIGTERM");
            else ctx.shutdown();
          }
        } else if (request.kind === "load") {
          if (state.active?.role !== "receiver" || state.active.peer !== request.source) throw new Error("This Pi did not request that takeover.");
          const receiving = describe(ctx);
          if (receiving.sessionFile !== request.receiverSession) throw new Error("The receiving conversation changed during takeover.");
          const transfer = request.transfer;
          if (transfer.agentDir !== receiving.agentDir) throw new Error("The source uses a different Pi agent directory.");
          state.restore = transfer;
          state.replacing = true;
          const result = await ctx.switchSession(transfer.sessionFile, {
            withSession: async fresh => {
              state.replacing = false;
              try {
                if (state.restore) throw new Error("Destination startup did not restore the source model and tools.");
                state.ready!(transfer);
                await reply({ ready: true });
                fresh.ui.notify("Session taken. Its previous Pi process will close; drafts and shell panels have not moved.", "info");
              } catch (error) {
                const message = `This Pi now shows the source conversation, but readiness failed: ${error instanceof Error ? error.message : String(error)}. The source remains open; inspect both views before continuing.`;
                state.report?.(message);
                await reply(undefined, message).catch(() => {});
              }
            },
          });
          if (result.cancelled) throw new Error("The destination cancelled session replacement.");
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        state.report?.(message);
        await reply(undefined, message).catch(() => {});
      } finally {
        state.replacing = false;
        state.restore = undefined;
        if (ownsSource && !sourceReady) {
          state.active = undefined;
          transferOperation().active = false;
        }
      }
    },
  });

  pi.registerCommand("take", {
    description: "Take an idle conversation from another frontend into this Pi. Usage: /take [tau|herdr]",
    handler: async (args, ctx: ExtensionCommandContext) => {
      if (state.active || transferOperation().active) { ctx.ui.notify("A session transfer is already in progress.", "warning"); return; }
      transferOperation().active = true;
      try {
        const receiving = describe(ctx);
        const kind = args.trim() || (receiving.frontend === "herdr" ? "tau" : "herdr");
        if ((kind !== "herdr" && kind !== "tau") || kind === receiving.frontend) throw new Error("Use /take tau in Herdr, or /take herdr in Tau.");
        const candidates = (await listTakeCandidates(kind, process.env)).filter(candidate => candidate.agentDir === receiving.agentDir && candidate.socket !== state.socket);
        if (!candidates.length) throw new Error(`No idle ordinary ${kind} sessions are available. Reload Pi in the source if it predates /take.`);
        const selected = await ctx.ui.select(`Take an idle session from ${kind}`, candidates.map(candidate => candidate.label));
        if (!selected) return;
        const candidate = candidates.find(candidate => candidate.label === selected)!;
        idle(ctx);
        if (ctx.sessionManager.getSessionFile() !== receiving.sessionFile) throw new Error("The receiving conversation changed while choosing a source.");
        state.active = { role: "receiver", peer: candidate.socket };
        const result = await requestTake<{ taken: boolean }>(candidate.socket, {
          kind: "take", sessionFile: candidate.sessionFile!, receiver: state.socket!, receiverSession: receiving.sessionFile,
        });
        if (!result.taken) throw new Error("The source did not confirm takeover.");
      } catch (error) {
        // The command context may have been replaced by the nested load. Report
        // through the current runtime, not the captured extension context.
        const message = error instanceof Error ? error.message : String(error);
        state.report?.(message);
      } finally {
        state.active = undefined;
        transferOperation().active = false;
      }
    },
  });
}
