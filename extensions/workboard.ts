import type {
  ContextEvent,
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import fs from "node:fs/promises";
import path from "node:path";

const WORKBOARD_FILE = "workboard.md";
const MAX_CONTEXT_CHARS = 30_000;
const WORKBOARD_CUSTOM_TYPE = "pi-ant:workboard";

const WORKBOARD_TEMPLATE = `# Workboard

This file is operational state for agents working in this repository.

pi-ant autoloads this file into agent context whenever it exists in the current
working directory. Agents do not need to be told to read it separately. Use the
\`edit\` tool to update this file and avoid using the \`write\` tool. Always keep it
up to date when task state changes, when blockers or decisions appear, and when
handoffs or plans change. Keep entries concise. Link to files instead of copying
long context.

This is not design authority or a cold idea backlog. Durable facts belong in
AGENTS.md, spec/, required-reading/, or equivalent project authority docs. Ideas
that should not enter the agent workflow yet belong in a project backlog or
ideas file outside workboard.md. Current runnable queues, blockers, and short
handoff notes belong here. Longer mutation plans, handoffs, and temporary
working notes belong in \`scratch/\`, with this file linking to them.

Treat \`scratch/\` as temporary operational memory. Clean up stale scratch files
when entries move to previous-done. Git history is the record; do not keep
obsolete scratch files or workboard history just to preserve what happened.

## How to use this file

Use this file as an index of current operational state. Each entry should be a
short note plus links to the files that contain details.

Create a separate \`scratch/\` details file when an issue needs more than a few
sentences, contains a plan/handoff, needs code or API examples, or may be worked
by another agent later. Edit only the pointer and current status into this file.

Edit only a note into this file when the issue is a small blocker, a concrete
question, or a short next action that does not need its own artifact.

Do not park cold ideas here. First promote them from backlog/ideas into
\`needs-enrichment\` for investigation/planning or \`ready\` for execution.

Move entries as their state changes. Delete obsolete entries instead of carrying
history. If an entry records a durable fact, move that fact into the authority
docs. When work completes, replace the previous-done entry with the latest
completed item and clean up obsolete scratch files.

Generic entry shape:

- Short title.
  - Status/next action.
  - Details: \`scratch/<slug>-plan.md\`, \`scratch/<slug>-handoff.md\`, or
    \`scratch/decisions/<slug>.md\` if needed.

## needs-enrichment
Use: Vague tasks that need context gathering before design or implementation. Enrichment that writes or materially changes a plan should review it with minitask, triage that review in the same pass, then move executable work to ready or unresolved questions to needs-decision.

- None.

## needs-decision
Use: Items blocked on a user/design decision. Include the concrete question and link a \`scratch/decisions/<slug>.md\` artifact.

- None.

## ready
Use: Clear tasks with enough context to execute.

- None.

## implementing
Use: Active work. Include the session/agent, current scope, and handoff file if any.

- None.

## needs-distill
Use: Work that is done or mostly done, but durable facts still need to be moved into authority docs and stale plans/history need cleanup.

- None.

## previous-done
Use: The latest completed workboard item only. Replace this entry whenever a task moves here; do not accumulate history in workboard.md.

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
    ? `\n\n[workboard.md truncated in context: showing first ${MAX_CONTEXT_CHARS} of ${originalChars} characters. Keep workboard.md concise.]`
    : "";

  return `A workboard.md file exists in the current working directory and is autoloaded as active operational state. Use it to understand runnable queues, blockers, active work, handoffs, and items needing distillation. Keep it up to date when task state changes. It is not design authority or a cold idea backlog; durable facts belong in AGENTS.md, spec/, required-reading/, or equivalent authority docs, and unpromoted ideas belong in project backlog/ideas files outside workboard.md.\n\n<workboard.md>\n${text}${truncationNotice}\n</workboard.md>`;
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
