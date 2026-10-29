import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { assertTransferIdle, captureTransfer, saveTransfer, switchSource, transferOperation } from "../session-transfer.ts";
import { registerTake } from "./take.ts";
import type { HostTarget } from "../host-types.ts";
import { listTargets } from "../workers.ts";
import {
  prepareSwitch,
  type PreparedSwitch, type SwitchDestination, type SwitchSource,
} from "../switch-destinations.ts";

export interface SwitchDependencies {
  prepare: (kind: SwitchDestination, source: SwitchSource) => Promise<PreparedSwitch>;
  targets: () => HostTarget[];
  environment: () => NodeJS.ProcessEnv;
}

export function registerSwitch(pi: ExtensionAPI, dependencies: SwitchDependencies = {
  prepare: prepareSwitch, targets: listTargets, environment: () => process.env,
}): void {
  pi.registerCommand("switch", {
    description: "Open this idle session in Herdr, Tau or Emacs, keeping this view open. Usage: /switch [herdr|tau|emacs]",
    handler: async (args, ctx) => {
      if (transferOperation().active) { ctx.ui.notify("A session transfer is already in progress.", "warning"); return; }
      transferOperation().active = true;
      let replacing = false;
      try {
        let destination = args.trim();
        if (!destination) destination = await ctx.ui.select("Open this session in", ["herdr", "tau", "emacs"]) ?? "";
        if (!destination) return;
        if (destination !== "herdr" && destination !== "tau" && destination !== "emacs") {
          throw new Error("Usage: /switch [herdr|tau|emacs]. tmux transfers are not implemented.");
        }
        assertTransferIdle(pi, ctx, dependencies.targets());
        const environment = dependencies.environment();
        // In a TUI, an explicit web orchestration host selects future workers,
        // not the frontend containing this conversation. It must still transfer.
        const current = ctx.mode === "rpc" ? environment.PI_ORCHESTRATION_HOST
          : environment.HERDR_ENV === "1" ? "herdr" : undefined;
        if (current === (destination === "tau" ? "web" : destination)) {
          ctx.ui.notify(`This session is already in ${destination}.`, "info");
          return;
        }
        const transfer = captureTransfer(pi, ctx, environment);
        const sessionFile = transfer.sessionFile;
        const source = switchSource(transfer, environment);
        const prepared = await dependencies.prepare(destination, source);
        // An asynchronous preflight or picker may have allowed another input.
        assertTransferIdle(pi, ctx, dependencies.targets());
        if (ctx.model?.provider !== transfer.model.provider || ctx.model.id !== transfer.model.id || pi.getThinkingLevel() !== transfer.thinking) {
          throw new Error("The model changed during preflight; switch cancelled.");
        }
        saveTransfer(pi, ctx, environment);
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
        transferOperation().active = false;
      }
    },
  });
}

export default function switchExtension(pi: ExtensionAPI): void {
  registerSwitch(pi);
  registerTake(pi);
}
