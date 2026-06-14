export interface PromptSnippet {
  key: string;
  value: string;
  description: string;
}

export const PRINCIPLES_SUFFIX =
  "Note our design principles: Do the hard part first, clean up as you go, leave no dead code or overcomplicated abstractions behind, being broken between phases is fine, cost of change is 0, avoid quick fixes / hacks, well designed longterm architecture endstate is critcal. Clear, consistent names are important; immediately refactor and rename things to best describe reality.";

export const CUT_SUFFIX =
  "Take a step back before continuing. Re-state the outer problem, then separate essential complexity from accidental complexity in the current frame/code/plan. Ask what should not exist, what mechanisms duplicate the same boundary, what state or authority boundary is in the wrong owner, and whether a cleaner cut would collapse the problem. If the current direction is wrong-shape, pause and propose the simpler cut before editing; ask me about real design choices.";

export const MINI_REVIEW_SUFFIX =
  "Ask minitask for a generic review of this, just issues and potential improvements. Then you evaluate its suggestions: apply clearly good ones, ignore bad ones, and ask me about anything uncertain.";

export const CALL_PROGRESS_SNIPPET = `Use call to execute the plan we just discussed. Your task as controller:

Important: call opens a call frame in the current session context with tools enabled. The call frame must finish by calling return. The tool-heavy call branch stays inspectable in the session tree, while the controller resumes from only the compact return result.

Start with a single call assigned to execute the entire feasible plan as far as possible. Do not split the work into phases by default. Use additional calls only after the prior call returns with completed work, blockers, remaining scope, or a clear handoff. For dependent tasks or tasks that may edit the same files, run calls serially and include the latest returned state/results in each new call task.

Tell each call frame to:

1. Execute as much of the supplied plan and scope as possible before returning.
2. Make the necessary code, document, and spec changes directly when safe.
3. Run focused relevant checks when practical.
4. If the work writes or materially changes a plan, ask minitask for a generic review of the plan before returning. Triage the review in the same call frame: apply clearly good suggestions, ignore bad ones, and move real unresolved questions to needs-decision with a scratch/decisions artifact.
5. Update workboard.md as required before returning, when this work came from a workboard item.
6. Call return with { result: "..." }, where result is the exact concise text to return to the caller. Include changed files, checks, remaining work, and blockers in that text only when relevant.

After each return, inspect the result, verify or clean up as needed, and decide whether another call should continue with updated context. You may pause when a major unexpected blocker or design choice is uncovered.

You are done when all feasible parts of the plan have been implemented, relevant specs and documents updated, relevant checks completed or clearly reported, and you have returned a final summary of what was done plus any remaining obstacles.`;

export const SUPERVISE_SNIPPET = `Spawn a tmux-coding-agent named 'main' to execute the plan we just discussed in phases in serial. Your task as supervisor:

Important: every tmux-coding-agent you spawn starts with a fresh conversation and has no previous knowledge of this discussion, prior agents, or their work. It will already have read AGENTS.md/context files for its working directory before your first message, so only provide task-specific context: the task, current state, relevant files, constraints not already covered there, and handoff notes.

Always wait for every tmux-coding-agent you spawn with semaphore_wait(..., timeoutSeconds: 600).

1. Observe the main agent and prevent it from going dormant.
2. Ensure it stays below 89% context use. If it exceeds it, ask it to write a handoff.md and spawn a new agent to continue its work. Assume that new agent knows only its loaded AGENTS.md/context plus what you provide in its initial prompt and the handoff file.
3. Ensure architectural quality: if the main agent is rushing to a quick fix instead of building a well-structured solution, nudge it to slow down, investigate alternatives, and get the design right.
4. Do not tell the main agent it has a supervisor.

You may pause when a major unforeseen blocker or design choice is uncovered. You are done when all feasible phases have been implemented, relevant specs/documents updated, relevant checks completed or clearly reported, and you have returned a final summary. Commit only if I explicitly requested a commit.`;

export const API_REVIEW_SNIPPET = `Before implementing, do a concise API/architecture review.

Focus on preventing the common failure mode: adding a plausible abstraction before proving it is the simplest clean end-state.

Check:

1. Smallest end-state shape: what is the simplest API shape that satisfies the real use cases? Can this be a concrete type/function before it becomes a trait, facade, callback wrapper, provider abstraction, or plugin seam?
2. State ownership and boundaries: what state is durable/shared vs per-session/per-evaluation/per-call? Is runtime/temporary state leaking into durable objects?
3. No alternate semantics: do fast paths, trusted paths, local shortcuts, caches, or materialized views preserve the same semantic contract, or explicitly name their different authority contract?
4. Naming matches reality: which stale names should be removed now rather than carried as compatibility?
5. Compatibility/shim pressure: is any layer being kept only to avoid editing call sites? Would deleting the old shape make the design clearer?
6. User decision points: what choice materially affects public API, persistence, protocol semantics, or long-term architecture?

Return: recommended shape, avoided abstractions/shims, state ownership, semantic risks, names to remove/rename, and questions for me if any. Do not implement until this review is done.`;

export const ENRICH_SNIPPET = `Perform an enrichment pass only. Do not implement source changes or authority-doc changes.

Read the relevant required-reading, handoff, plans, and current code/docs for this topic. If you write or materially change a plan, ask minitask for a generic review of the plan before finishing, then triage the review in the same pass: apply clearly good suggestions, ignore bad ones, and split real unresolved questions into needs-decision with a scratch/decisions artifact.

Return with:
1. Current factual state with file references.
2. Stale or contradictory docs.
3. Open design questions, with decision artifacts for questions needing human input.
4. What can be decided now vs what needs user input.
5. Risks of overcomplication or stale compatibility.
6. How workboard.md was updated: usually move executable enriched work to ready, or move blockers to needs-decision.

Separate facts, inferences, and guesses. Do not edit source code or authority docs during enrichment.`;

export const DISTILL_SNIPPET = `Before finishing, distill durable facts from this work.

Update required-reading/spec/AGENTS only with current factual state.
Move mutation plans/status/history into ordinary root docs or delete them if obsolete.
Remove stale compatibility language, old names, and misleading transitional docs.

Then report:
- durable facts recorded,
- obsolete docs removed/updated,
- remaining non-durable plans,
- anything still uncertain.`;

export const SNIPPETS: PromptSnippet[] = [
  {
    key: "principles",
    value: PRINCIPLES_SUFFIX,
    description: "Insert the design principles suffix",
  },
  {
    key: "cut",
    value: CUT_SUFFIX,
    description: "Insert the cut/framing suffix",
  },
  {
    key: "mini-review",
    value: MINI_REVIEW_SUFFIX,
    description: "Insert the minitask review suffix",
  },
  {
    key: "call-progress",
    value: CALL_PROGRESS_SNIPPET,
    description: "Insert call-frame progress instructions",
  },
  {
    key: "supervise",
    value: SUPERVISE_SNIPPET,
    description: "Insert tmux coding-agent supervisor instructions",
  },
  {
    key: "api-review",
    value: API_REVIEW_SNIPPET,
    description: "Insert API/architecture review instructions",
  },
  {
    key: "enrich",
    value: ENRICH_SNIPPET,
    description: "Insert enrichment instructions",
  },
  {
    key: "distill",
    value: DISTILL_SNIPPET,
    description: "Insert durable-facts distillation instructions",
  },
];
