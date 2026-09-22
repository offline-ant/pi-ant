/**
 * Agent-triggered compaction with a verbatim handoff note.
 *
 * The agent calls `self_compact({note})` alone in its tool batch. The run ends,
 * Pi's native compaction runs once the session settles (normal summary prompt,
 * model, retention, and previous-summary chaining), and the note is then
 * delivered unchanged as the next message, which continues the work.
 *
 * Idea adapted from https://github.com/disler/self-compact-pi-agent
 * (MIT, Copyright (c) 2026 IndyDevDan).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const SELF_COMPACT_TOOL = "self_compact";
export const SELF_COMPACT_MESSAGE = "self-compact";
export const SELF_COMPACT_REMINDER = "self-compact-reminder";
/** Context usage (percent of the model window) at which the model is reminded to self-compact. */
export const REMINDER_PERCENT = 50;

interface PendingHandoff {
  toolCallId: string;
  note: string;
}

function toolCallsInLatestAssistant(ctx: ExtensionContext): string[] {
  const branch = ctx.sessionManager.getBranch();
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index]!;
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    return entry.message.content.flatMap((block) => block.type === "toolCall" ? [block.id] : []);
  }
  return [];
}

export default function selfCompact(pi: ExtensionAPI) {
  let pending: PendingHandoff | undefined;
  let active = true;

  const report = (text: string) => pi.sendMessage({ customType: SELF_COMPACT_MESSAGE, content: text, display: true });

  pi.registerTool({
    name: SELF_COMPACT_TOOL,
    label: "Self Compact",
    description:
      "Compact your own context at a clean checkpoint. Call it as the only tool call in its batch. " +
      "The run ends, Pi's normal compaction summarizes older history while keeping recent messages, " +
      "and your note is then returned verbatim as the next message so you continue from it without a human prompt.",
    promptSnippet: "Compact your own context at a clean checkpoint, handing yourself a verbatim note",
    promptGuidelines: [
      `Call ${SELF_COMPACT_TOOL} alone in its tool batch at a clean checkpoint when context usage is high or when asked to.`,
      `A ${SELF_COMPACT_TOOL} note states the goal and user constraints, completed work with exact paths and commands, in-progress state, key decisions, verified results, and ends with the exact next action. Never list finished work as pending.`,
      `After a ${SELF_COMPACT_TOOL} handoff note arrives, continue only its unfinished next action; if the task is complete, report completion and stop.`,
    ],
    parameters: Type.Object({
      note: Type.String({ description: "Handoff note to your post-compaction self, ending with the exact next action." }),
    }),
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) throw new Error("Self-compaction cancelled.");
      if (!params.note.trim()) throw new Error("note must not be blank.");
      const batch = toolCallsInLatestAssistant(ctx);
      if (batch.length !== 1 || batch[0] !== toolCallId) {
        throw new Error(`${SELF_COMPACT_TOOL} must be the only tool call in its batch. Nothing was compacted; call it again alone.`);
      }
      pending = { toolCallId, note: params.note };
      return {
        content: [{ type: "text", text: "Note saved. Stop now: compaction runs when this turn ends, then your note is returned verbatim." }],
        details: {},
        terminate: true,
      };
    },
  });

  pi.on("agent_settled", (_event, ctx) => {
    const handoff = pending;
    pending = undefined;
    if (!handoff) return;
    const leaf = ctx.sessionManager.getLeafEntry();
    if (leaf?.type !== "message" || leaf.message.role !== "toolResult" || leaf.message.toolCallId !== handoff.toolCallId) {
      report("Self-compaction skipped: the conversation moved on after the note was saved. Context was not compacted.");
      return;
    }
    ctx.compact({
      onComplete: () => {
        if (!active) return;
        if (ctx.sessionManager.getLeafEntry()?.type !== "compaction") return;
        pi.sendMessage({ customType: SELF_COMPACT_MESSAGE, content: handoff.note, display: true }, { triggerTurn: true });
      },
      onError: (error) => {
        if (!active) return;
        report(`Self-compaction failed: ${error.message}. Context was not compacted and work has stopped; the note was not delivered.`);
      },
    });
  });

  pi.on("context", (event, ctx) => {
    if (!pi.getActiveTools().includes(SELF_COMPACT_TOOL)) return undefined;
    const usage = ctx.getContextUsage();
    if (usage?.percent == null || usage.percent < REMINDER_PERCENT) return undefined;
    const content = `Context usage is ${Math.round(usage.percent)}% (${usage.tokens} of ${usage.contextWindow} tokens). ` +
      `At the next clean checkpoint, call ${SELF_COMPACT_TOOL} alone with your handoff note.`;
    return {
      messages: [...event.messages, {
        role: "custom" as const, customType: SELF_COMPACT_REMINDER, content, display: false, timestamp: Date.now(),
      }],
    };
  });

  pi.on("session_shutdown", () => {
    active = false;
    pending = undefined;
  });
}
