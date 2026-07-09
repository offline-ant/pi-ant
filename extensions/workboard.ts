import type {
  ContextEvent,
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import fs from "node:fs/promises";
import path from "node:path";
import { ensureWorkflowFile, WORKFLOW_FILE } from "./workflow-core.ts";

const WORKBOARD_FILE = "workboard.md";
const MAX_CONTEXT_CHARS = 30_000;
const WORKBOARD_CUSTOM_TYPE = "pi-ant:workboard";

const WORKBOARD_TEMPLATE = `# Workboard

Active operational state for this repository. pi-ant autoloads this file; update
it with \`edit\` whenever task state, blockers, decisions, handoffs, or plans
change.

Keep required status, decisions, blockers, and next actions here, linking
supporting detail instead of copying it. Put plans and handoffs in \`scratch/\`,
human decisions in \`scratch/decisions/\`, durable facts in authority docs, and
unpromoted ideas in a separate backlog. Delete obsolete state and stale scratch
files; git history preserves history.

Guidance policy lives in \`workflow.md\`. Move entries as their state changes.
Plan changes require a minitask review before executable work moves to \`ready\`;
material unresolved choices move to \`needs-decision\`.

Entry shape:

- Title.
  - Current state, blockers, and next action.
  - Details: \`scratch/<slug>-plan.md\`, \`scratch/<slug>-handoff.md\`, or
    \`scratch/decisions/<slug>.md\` when needed.

## needs-enrichment
Tasks missing context or a safe plan.

- None.

## needs-decision
Tasks blocked on a material human decision; include the question and decision artifact.

- None.

## ready
Tasks with enough context to execute.

- None.

## implementing
Active work; include worker/session, scope, blockers, and handoff when needed.

- None.

## needs-distill
Completed work whose durable facts or stale temporary docs still need cleanup.

- None.

## previous-done
Latest completed item only; replace the old entry instead of accumulating history.

- None.
`;

function truncateWorkboard(text: string): {
  text: string;
  truncated: boolean;
  originalChars: number;
} {
  if (text.length <= MAX_CONTEXT_CHARS) {
    return { text, truncated: false, originalChars: text.length };
  }

  return {
    text: text.slice(0, MAX_CONTEXT_CHARS),
    truncated: true,
    originalChars: text.length,
  };
}

function formatWorkboardContext(
  text: string,
  truncated: boolean,
  originalChars: number,
): string {
  const truncationNotice = truncated
    ? `\n\n[workboard.md truncated: first ${MAX_CONTEXT_CHARS} of ${originalChars} characters. Retain status, decisions, blockers, and next actions; link supporting detail.]`
    : "";

  return `workboard.md is autoloaded operational state. Keep its runnable queues, blockers, handoffs, decisions, and next actions current. workflow.md defines guidance policy. Put durable facts in authority docs and unpromoted ideas in a separate backlog.\n\n<workboard.md>\n${text}${truncationNotice}\n</workboard.md>`;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("new-workboard", {
    description:
      "Create workboard.md with operational-state sections and update instructions",
    handler: async (_args, ctx) => {
      const workboardPath = path.join(ctx.cwd, WORKBOARD_FILE);
      if (await fileExists(workboardPath)) {
        ctx.ui.notify(
          `${WORKBOARD_FILE} already exists; not overwriting.`,
          "warning",
        );
        return;
      }

      await fs.writeFile(workboardPath, WORKBOARD_TEMPLATE, {
        encoding: "utf8",
        flag: "wx",
      });
      ctx.ui.notify(`Created ${WORKBOARD_FILE}.`, "info");
    },
  });

  pi.registerCommand("new-workflow", {
    description: "Create workflow.md with editable guidance policy",
    handler: async (_args, ctx) => {
      if (await ensureWorkflowFile(ctx.cwd)) {
        ctx.ui.notify(`Created ${WORKFLOW_FILE}.`, "info");
        return;
      }

      ctx.ui.notify(
        `${WORKFLOW_FILE} already exists; not overwriting.`,
        "warning",
      );
    },
  });

  pi.on("context", async (event: ContextEvent, ctx) => {
    const workboardPath = path.join(ctx.cwd, WORKBOARD_FILE);
    let content: string;
    try {
      content = await fs.readFile(workboardPath, "utf8");
    } catch {
      return undefined;
    }

    const truncated = truncateWorkboard(content);
    return {
      messages: [
        ...event.messages,
        {
          role: "custom" as const,
          customType: WORKBOARD_CUSTOM_TYPE,
          content: formatWorkboardContext(
            truncated.text,
            truncated.truncated,
            truncated.originalChars,
          ),
          display: false,
          details: {
            path: workboardPath,
            truncated: truncated.truncated,
            originalChars: truncated.originalChars,
          },
          timestamp: Date.now(),
        },
      ],
    };
  });
}
