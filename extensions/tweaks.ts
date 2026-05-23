/**
 * Tweaks — small session-level adjustments.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PRINCIPLES_SUFFIX =
  "Note our design principles: Do the hard part first, clean up as you go, leave no dead code or overcomplicated abstractions behind, being broken between phases is fine, cost of change is 0, avoid quick fixes / hacks, well designed longterm architecture endstate is critcal.";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("principles", {
    description: "Send optional input with the design principles suffix",
    handler: async (args, ctx) => {
      const input = args.trim();
      const message = `${input} ${PRINCIPLES_SUFFIX}`;
      if (ctx.isIdle()) {
        pi.sendUserMessage(message);
      } else {
        pi.sendUserMessage(message, { deliverAs: "followUp" });
        ctx.ui.notify("Queued /principles message", "info");
      }
    },
  });

  pi.on("session_start", async () => {
    let active = pi.getActiveTools();
    // Enable grep (registered but not in the default active set)
    if (!active.includes("grep")) active = [...active, "grep"];
    pi.setActiveTools(active);
  });
}
