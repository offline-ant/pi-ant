import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TOOL_SELECTION_ENTRY } from "../../extensions/tool-selection.ts";
import { modelCliArgs } from "../context.ts";
import type { HostTarget } from "../host-types.ts";
import { listTargets } from "../workers.ts";
import {
  prepareSwitch, switchEnvironment,
  type PreparedSwitch, type SwitchDestination, type SwitchSource,
} from "../switch-destinations.ts";

export interface SwitchDependencies {
  prepare: (kind: SwitchDestination, source: SwitchSource) => Promise<PreparedSwitch>;
  targets: () => HostTarget[];
  environment: () => NodeJS.ProcessEnv;
}

// Replacement reloads extensions. Keep only the in-flight command guard across
// that reload; session state itself remains in Pi's ordinary session file.
const SWITCHING = Symbol.for("pi-orchestration:switching");
function switching(): { active: boolean } {
  const global = globalThis as typeof globalThis & { [SWITCHING]?: { active: boolean } };
  return global[SWITCHING] ??= { active: false };
}

export function registerSwitch(pi: ExtensionAPI, dependencies: SwitchDependencies = {
  prepare: prepareSwitch, targets: listTargets, environment: () => process.env,
}): void {
  pi.registerCommand("switch", {
    description: "Open this idle session in Herdr or Tau, keeping this view open. Usage: /switch [herdr|tau]",
    handler: async (args, ctx) => {
      if (switching().active) { ctx.ui.notify("A session switch is already in progress.", "warning"); return; }
      switching().active = true;
      let replacing = false;
      try {
        let destination = args.trim();
        if (!destination) destination = await ctx.ui.select("Open this session in", ["herdr", "tau"]) ?? "";
        if (!destination) return;
        if (destination !== "herdr" && destination !== "tau") throw new Error("Usage: /switch [herdr|tau]. Emacs and tmux transfers are not implemented.");
        if (!ctx.isIdle() || ctx.hasPendingMessages()) throw new Error("Wait for the current turn and queued messages to finish before switching.");
        const guard = { blocked: false };
        pi.events.emit("pi-orchestration:switch-check", guard);
        if (guard.blocked) throw new Error("Cannot switch an active managed worker.");
        const ugo = ctx.sessionManager.getBranch().findLast((entry) => entry.type === "custom" && entry.customType === "pi-ant:ugo-state");
        if (ugo?.type === "custom" && typeof ugo.data === "object" && ugo.data !== null
          && "active" in ugo.data && ugo.data.active === true) throw new Error("Stop Ugo before switching this session.");
        const file = ctx.sessionManager.getSessionFile();
        if (!file || !fs.existsSync(file)) throw new Error("This session is not persisted; send a message before switching.");
        const sessionFile = fs.realpathSync(file);
        if (dependencies.targets().some((target) => {
          if (!target.sessionFile) return false;
          try { return fs.realpathSync(target.sessionFile) === sessionFile; }
          catch { return path.resolve(target.sessionFile) === sessionFile; }
        })) throw new Error("Cannot switch a registered worker or interactive fork. Finish its managed lifecycle first.");
        const environment = dependencies.environment();
        // In a TUI, an explicit web orchestration host selects future workers,
        // not the frontend containing this conversation. It must still transfer.
        const current = ctx.mode === "rpc" ? environment.PI_ORCHESTRATION_HOST
          : environment.HERDR_ENV === "1" ? "herdr" : undefined;
        if (current === (destination === "tau" ? "web" : destination)) {
          ctx.ui.notify(`This session is already in ${destination}.`, "info");
          return;
        }
        const source: SwitchSource = {
          sessionFile, cwd: ctx.cwd, args: modelCliArgs(ctx.model, pi.getThinkingLevel()), env: switchEnvironment(environment),
        };
        // Explicit Herdr selection may use PI_ORCHESTRATION_ENDPOINT rather than
        // the native marker. Retain that socket, not stale pane identity, in Tau.
        if (environment.PI_ORCHESTRATION_HOST === "herdr" && environment.PI_ORCHESTRATION_ENDPOINT) {
          source.env.HERDR_SOCKET_PATH = environment.PI_ORCHESTRATION_ENDPOINT;
        }
        const prepared = await dependencies.prepare(destination, source);
        // An asynchronous preflight or picker may have allowed another input.
        if (!ctx.isIdle() || ctx.hasPendingMessages()) throw new Error("Session became busy during preflight; switch cancelled.");
        pi.appendEntry(TOOL_SELECTION_ENTRY, { enabledTools: pi.getActiveTools() });
        ctx.ui.notify(`Opening in ${destination}. This conversation stays open here; drafts and shell panels do not move.`, "info");
        replacing = true;
        // Reload the same file to release the old provider and idle cache warmer,
        // without removing the visible conversation or exiting either frontend.
        const result = await ctx.switchSession(sessionFile, {
          withSession: async (fresh) => {
            // No captured ExtensionAPI or old context may be used here.
            try {
              if (!fresh.isIdle() || fresh.hasPendingMessages()) throw new Error("Replacement startup began work; switch cancelled.");
              const location = await prepared.start();
              const receipt = `Session open in ${location}\nThis view stays open but does not sync. Before continuing here, leave the other view idle and use /resume to select this session and load its latest history.`;
              fresh.ui.notify(receipt, "info");
              if (fresh.mode === "tui") fresh.ui.setWidget("session-switch", receipt.split("\n"));
            } catch (error) {
              const message = error instanceof Error ? error.message : "Destination startup did not confirm completion.";
              fresh.ui.notify(`${message}\nThis conversation remains open. Check the destination, then use /resume before continuing here.`, "error");
            }
          },
        });
        if (result.cancelled) ctx.ui.notify("Session switch cancelled; the original session remains active.", "info");
      } catch (error) {
        const message = error instanceof Error ? error.message : "Session switch failed.";
        if (!replacing) ctx.ui.notify(message, "error");
        else {
          const refresh = `Session refresh failed: ${message}\nUse /resume to reopen the session before continuing.`;
          // The old context is stale if replacement had already begun.
          try { ctx.ui.notify(refresh, "error"); } catch { process.stderr.write(`${refresh}\n`); }
        }
      } finally {
        switching().active = false;
      }
    },
  });
}

export default function switchExtension(pi: ExtensionAPI): void { registerSwitch(pi); }
