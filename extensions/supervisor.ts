/**
 * /supervise — spawn a supervised coding agent in tmux.
 * /minivise — execute a plan through one or more minitask runs.
 *
 * Usage:  /supervise <task description>
 * Usage:  /minivise <task description>
 *
 * Tells the current agent to orchestrate delegated execution work.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("supervise", {
    description:
      "Spawn a supervised tmux coding agent. Usage: /supervise <task>",
    handler: async (args, ctx) => {
      const task = (args ?? "").trim();

      const supervisorMessage = task
        ? `Spawn a tmux-coding-agent named 'main' to: ${task}`
        : `Spawn a tmux-coding-agent named 'main' to execute the plan we just discussed in phases in serial`;

      const message = `${supervisorMessage} Your jobs as supervisor:

Important: every tmux-coding-agent you spawn starts with a fresh conversation and has no previous knowledge of this discussion, prior agents, or their work. It will already have read AGENTS.md/context files for its working directory before your first message, so only provide task-specific context: the task, current state, relevant files, constraints not already covered there, and handoff notes.

Always wait for every tmux-coding-agent you spawn with semaphore_wait(..., timeoutSeconds: 600).

1. Observe the main agent and prevent it from going dormant.
2. Ensure it stays below 89% context use. If it exceeds it, ask it to write a handoff.md and spawn a new agent to continue its work. Assume that new agent knows only its loaded AGENTS.md/context plus what you provide in its initial prompt and the handoff file.
3. **Ensure architectural quality** — if the main agent is rushing to a quick fix instead of building a well-structured solution, nudge it to slow down, investigate alternatives, and get the design right. Dependencies are not automatically correct — vendoring, replacing, or changing APIs is on the table if it's the right call. That's the whole point of this supervised workflow.
4. **Ensure the main agent commits** — when the task is complete, make sure the main agent commits its work before stopping.

Do NOT tell the main agent it has a supervisor.

You may decide to pause when a major unforseen blocker or design choice is uncovered.

You are done when all phases of the plan have been fully implemented, relevant specs & documents updated, and everything commited. 
`;

      if (ctx.isIdle()) {
        pi.sendUserMessage(message);
      } else {
        pi.sendUserMessage(message, { deliverAs: "followUp" });
        ctx.ui.notify("Queued /supervise message", "info");
      }
    },
  });

  pi.registerCommand("minivise", {
    description:
      "Execute a plan through one or more minitask runs. Usage: /minivise <task>",
    handler: async (args, ctx) => {
      const task = (args ?? "").trim();

      const supervisorMessage = task
        ? `Use minitask to execute: ${task}`
        : `Use minitask to execute the plan we just discussed in phases`;

      const message = `${supervisorMessage} Your task as supervisor:

Important: every minitask starts with a fresh conversation and has no previous knowledge of this discussion, prior minitasks, or their work. It will already have read AGENTS.md/context files for the working directory, so only provide task-specific context: the plan, current state, relevant files, constraints not already covered there, and exactly what scope it should attempt.

Use minitask for bounded, mostly independent pieces of the plan. For multiple independent, non-overlapping tasks, call minitask multiple times in parallel. For dependent tasks or tasks that may edit the same files, run minitasks serially and include the latest state/results in each new prompt.

Tell each minitask to:

1. Execute as many tasks as possible within the supplied plan and scope.
2. Make the necessary code, document, and spec changes directly when safe.
3. Run focused relevant checks when practical.
4. Return a concise report of what was done, files changed if known, checks run and results, and any unexpected problems, obstacles, or blockers.

After each minitask returns, inspect its report, verify or clean up as needed, and decide whether another minitask should continue with updated context. You may pause when a major unexpected blocker or design choice is uncovered.

You are done when all feasible phases of the plan have been implemented, relevant specs and documents updated, relevant checks completed or clearly reported, and you have returned a final summary of what was done plus any remaining obstacles.
`;

      if (ctx.isIdle()) {
        pi.sendUserMessage(message);
      } else {
        pi.sendUserMessage(message, { deliverAs: "followUp" });
        ctx.ui.notify("Queued /minivise message", "info");
      }
    },
  });
}
