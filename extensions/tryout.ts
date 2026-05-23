/**
 * /tryout — wrap a prompt so the agent proceeds carefully, stopping on errors.
 *
 * Usage:  /tryout <prompt>
 *
 * Injects the user's prompt into a wrapper that tells the agent to treat it
 * as an experimental tryout: proceed step by step, but pause and investigate
 * whenever something unexpected happens or an error surfaces.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("tryout", {
    description:
      "Run a task in tryout mode — stop and investigate on errors. Usage: /tryout <prompt>",
    handler: async (args, ctx) => {
      const task = (args ?? "").trim();
      if (!task) {
        ctx.ui.notify("Usage: /tryout <task description>", "error");
        return;
      }

      pi.sendUserMessage(
        `## Tryout Mode

You are in **tryout mode**. The goal:

> ${task}

### Rules for tryout mode

1. **Work step by step.** Do one small, concrete thing at a time — run a command,
   read a file, make a single edit — then verify before moving on.

2. **Stop and investigate on ANY surprise.** If a command fails, output looks
   wrong, a file isn't where you expect it, types don't match, tests fail, or
   *anything* deviates from what you predicted — **stop immediately**. Do NOT
   try to fix it right away. Instead:
   - State clearly what you expected vs. what happened.
   - Investigate the root cause (read logs, check versions, inspect state).
   - Only after you understand the cause, decide on the right fix.

3. **Report errors to me, don't power through them.** If you hit something you
   can't resolve or that changes the scope of the task, pause and tell me what's
   going on. Ask for guidance rather than guessing.

4. **No bulk changes.** Don't write large files or make sweeping edits in one
   shot. Small increments, verified as you go.

5. **Summarize after each step.** Briefly say what you did and what you observed
   before moving to the next step.

Begin now.`,
      );
    },
  });
}
