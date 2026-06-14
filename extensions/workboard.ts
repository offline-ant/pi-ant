import type { ContextEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fs from "node:fs/promises";
import path from "node:path";

const WORKBOARD_FILE = "workboard.md";
const MAX_CONTEXT_CHARS = 30_000;
const WORKBOARD_CUSTOM_TYPE = "pi-ant:workboard";

const WORKBOARD_TEMPLATE = `# Workboard

This file is operational state for agents working in this repository.

pi-ant autoloads this file into agent context whenever it exists in the current
working directory. Agents do not need to be told to read it separately. Always
keep it up to date when task state changes, when blockers or decisions appear,
and when handoffs or plans change. Keep entries concise. Link to files instead
of copying long context.

This is not design authority. Durable facts belong in AGENTS.md, spec/,
required-reading/, or equivalent project authority docs. Mutation plans, current
queues, reminders, blockers, and handoffs belong here.

## How to use this file

Use this file as an index of current operational state. Each entry should be a
short note plus links to the files that contain details.

Write the details into a separate file when an issue needs more than a few
sentences, contains a plan/review/handoff, needs code or API examples, or may be
worked by another agent later. Put only the pointer and current status here.

Write only a note here when the issue is a reminder, a small blocker, a concrete
question, or a short next action that does not need its own artifact.

Move entries as their state changes. Delete obsolete entries instead of carrying
history. If an entry records a durable fact, move that fact into the authority
docs and either remove the entry or move it to done with a file reference.

Generic entry shape:

- Short title.
  - Status/next action.
  - Details: \`path/to/file.md\` if details exist elsewhere.

## inbox

Raw ideas, reminders, and "do not forget" notes that are not ready to execute.

- 

## needs-enrichment

Vague tasks that need context gathering before design or implementation.

- 

## needs-decision

Items blocked on a user/design decision. Include the concrete question.

- 

## ready

Clear tasks with enough context to execute.

- 

## implementing

Active work. Include the session/agent, current scope, and handoff file if any.

- 

## needs-review

Completed work waiting for human or agent review.

- 

## needs-distill

Work that is done or mostly done, but durable facts still need to be moved into
authority docs and stale plans/history need cleanup.

- 

## done

Completed items with concise final references.

- 
`;

function truncateWorkboard(text: string): { text: string; truncated: boolean; originalChars: number } {
  if (text.length <= MAX_CONTEXT_CHARS) {
    return { text, truncated: false, originalChars: text.length };
  }

  return {
    text: text.slice(0, MAX_CONTEXT_CHARS),
    truncated: true,
    originalChars: text.length,
  };
}

function formatWorkboardContext(text: string, truncated: boolean, originalChars: number): string {
  const truncationNotice = truncated
    ? `\n\n[workboard.md truncated in context: showing first ${MAX_CONTEXT_CHARS} of ${originalChars} characters. Keep workboard.md concise.]`
    : "";

  return `A workboard.md file exists in the current working directory and is autoloaded as operational state. Use it to understand current queues, blockers, active work, handoffs, reminders, and items needing distillation. Keep it up to date when task state changes. It is not design authority; durable facts belong in AGENTS.md, spec/, required-reading/, or equivalent authority docs.\n\n<workboard.md>\n${text}${truncationNotice}\n</workboard.md>`;
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
    description: "Create workboard.md with operational-state sections and update instructions",
    handler: async (_args, ctx) => {
      const workboardPath = path.join(ctx.cwd, WORKBOARD_FILE);
      if (await fileExists(workboardPath)) {
        ctx.ui.notify(`${WORKBOARD_FILE} already exists; not overwriting.`, "warning");
        return;
      }

      await fs.writeFile(workboardPath, WORKBOARD_TEMPLATE, { encoding: "utf8", flag: "wx" });
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
          content: formatWorkboardContext(truncated.text, truncated.truncated, truncated.originalChars),
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
