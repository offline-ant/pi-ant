/** Private coordination between self_compact and structured worker completion. */
export const SELF_COMPACT_HANDOFF_EVENT = "pi-ant:self-compact-handoff";

export type SelfCompactHandoff =
  | { state: "pending" | "resumed"; toolCallId: string }
  | { state: "failed"; toolCallId: string; reason: string };
