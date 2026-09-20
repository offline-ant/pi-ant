import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { waitForHerdrFinish } from "./herdr-finish-wait.ts";

export default function herdrFinish(pi: ExtensionAPI): void {
  const endpoint = process.env.HERDR_SOCKET_PATH;
  const paneId = process.env.HERDR_PANE_ID;
  if (process.env.HERDR_ENV !== "1" || !endpoint || !paneId) return;

  let registered = false;
  let active: { controller: AbortController; ctx: ExtensionContext } | undefined;

  function clear(): void {
    const wait = active;
    if (!wait) return;
    active = undefined;
    wait.controller.abort();
    wait.ctx.ui.setWidget("herdr-finish", undefined);
    // Cooperate with the managed integration instead of competing for Herdr state authority.
    pi.events.emit("herdr:blocked", { active: false });
  }

  function cancel(reason: string): void {
    if (!active) return;
    const ctx = active.ctx;
    clear();
    ctx.ui.notify(`Herdr wait cancelled: ${reason}`, "info");
  }

  pi.on("session_start", (_event, ctx) => {
    // RPC/print children may inherit Herdr variables without owning the pane.
    if (ctx.mode !== "tui" || registered) return;
    registered = true;
    for (const scope of ["tab", "space"] as const) {
      pi.registerCommand(`start-${scope}-finish`, {
        description: `Run a prompt here when all other agents in this Herdr ${scope} are idle/done`,
        handler: async (args, commandCtx) => {
          const prompt = args.trim();
          if (!prompt) {
            commandCtx.ui.notify(`Usage: /start-${scope}-finish <prompt>`, "warning");
            return;
          }
          if (active) {
            commandCtx.ui.notify("Already waiting. Use /start-finish-cancel before scheduling another prompt.", "warning");
            return;
          }
          if (!commandCtx.isIdle() || commandCtx.hasPendingMessages()) {
            commandCtx.ui.notify("Wait until this Pi is idle before scheduling a prompt.", "warning");
            return;
          }
          const wait = { controller: new AbortController(), ctx: commandCtx };
          active = wait;
          commandCtx.ui.setWidget("herdr-finish", [`Waiting for Herdr ${scope}; /start-finish-cancel to cancel`, prompt]);
          pi.events.emit("herdr:blocked", { active: true, label: `Waiting for ${scope} agents` });
          // Return from the command immediately so input and cancellation remain available.
          void waitForHerdrFinish({
            endpoint,
            paneId,
            sessionRef: commandCtx.sessionManager.getSessionFile() ?? commandCtx.sessionManager.getSessionId(),
            scope,
            signal: wait.controller.signal,
            progress: (pending) => {
              if (active !== wait) return;
              const summary = pending.slice(0, 8).map((pane) => `${pane.pane_id}: ${pane.agent_status}`).join(", ");
              commandCtx.ui.setWidget("herdr-finish", [
                `Waiting for Herdr ${scope}: ${pending.length} remaining; /start-finish-cancel`,
                ...(summary ? [summary + (pending.length > 8 ? ", …" : "")] : []),
                prompt,
              ]);
            },
          }).then(() => {
            if (active !== wait) return;
            if (!commandCtx.isIdle() || commandCtx.hasPendingMessages()) {
              cancel("this Pi is no longer idle");
              return;
            }
            clear();
            // Local Pi submission preserves human drafts. This is a live-state check,
            // not an atomic cross-agent scheduler or proof that other work succeeded.
            try {
              pi.sendUserMessage(prompt);
            } catch (error) {
              commandCtx.ui.notify(`Herdr prompt submission failed: ${error instanceof Error ? error.message : String(error)}`, "error");
            }
          }).catch((error: unknown) => {
            if (active !== wait) return;
            clear();
            commandCtx.ui.notify(`Herdr wait failed: ${error instanceof Error ? error.message : String(error)}`, "error");
          });
        },
      });
    }
    pi.registerCommand("start-finish-cancel", {
      description: "Cancel this Pi's pending Herdr finish prompt",
      handler: async (_args, commandCtx) => {
        if (active) cancel("requested");
        else commandCtx.ui.notify("No Herdr finish prompt is waiting.", "info");
      },
    });
  });

  pi.on("input", () => { cancel("another prompt was submitted"); });
  pi.on("agent_start", () => { cancel("this Pi started working"); });
  pi.on("session_tree", () => { cancel("the session branch changed"); });
  pi.on("session_shutdown", () => { clear(); });
}
