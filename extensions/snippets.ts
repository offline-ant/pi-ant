export interface PromptSnippet {
  key: string;
  value: string;
  description: string;
}

export const PRINCIPLES_SUFFIX =
  "Note our principles: Prefer the smallest clean long-term design. Treat the cost of change as zero and optimize for the clean end state. We have no users or legacy state to preserve: do not write compatibility code or parsers for obsolete formats. Prefer straightforward solutions over preemptive defensiveness; before adding a new choice or mechanism, establish that it is required. Do the hard part first; remove stale code and avoid shims, duplicate mechanisms, and speculative abstractions. Code not written cannot be wrong; delete anything that does not need to exist. Simplify as far as possible without worsening asymptotic complexity. Rename unclear concepts to match reality.";

export const EDIT_PRINCIPLES_SUFFIX =
  "Note our edit principels: Write for humans, not completeness checkers. Text never written is never wrong; omission is often better than another qualification. State the main point early and cut anything that does not serve the document's job. Prefer direct verbs, concrete nouns, visible actors, and plain terms. Let each paragraph do one thing. Make the strongest useful claim plainly, then narrow it where the exception matters instead of burdening every sentence with caveats. Name genuine uncertainty precisely. Structure for skimming, vary sentence rhythm naturally, and avoid canned transitions, artificial symmetry, significance puffery, and tidy conclusions that add nothing. Do not polish text that should be deleted.";

export const CUT_SUFFIX =
  "Before continuing, restate the outer problem and separate essential from accidental complexity. Identify duplicate mechanisms, misplaced state or authority, and things that should not exist. If the current direction has the wrong shape, pause and propose the simpler boundary before editing; ask only about material design choices.";

export const SIMPLIFY_SUFFIX =
  "Before changing anything, propose what can be deleted, inlined, merged, renamed, or not built. Prefer the smallest clean end state over options, compatibility layers, and abstractions that do not pull their weight. Show concrete simplifications and ask about material design choices; wait for approval before implementing them.";

export const DELEGATE_REVIEW_SUFFIX =
  "Use delegate with context='project' for a generic review of this, requesting only issues and potential improvements. Then evaluate its suggestions: apply clearly good ones, ignore bad ones, and ask me about anything uncertain.";

export const TS_SUFFIX = "Thoughts? Suggestions?";

export const DELEGATE_PROGRESS_SNIPPET = `Use delegate with context='inherit' to execute the feasible plan. Start with one cohesive delegate; add serial delegates only after a result exposes remaining work, a blocker, or a handoff. Never run dependent or overlapping edits in parallel.

Each delegate should make the in-scope code/docs changes, run relevant checks, and update workboard.md when applicable. If it materially changes a plan, review that plan with delegate context='clean' and triage the result before execution. Move unresolved material choices to needs-decision with a scratch/decisions artifact.

Verify each returned result before continuing. Finish with the parent-facing outcome: required changed files, checks, evidence, caveats, blockers, and next actions. Omit introductions, repetition, and optional background first. Stop only when feasible scope is complete or a real decision/external blocker is documented.`;

export const SUPERVISE_SNIPPET = `Use coding-agent named 'main' to execute the plan in serial phases. A new worker knows only its loaded project instructions, so provide the task, current state, relevant files, extra constraints, and handoff facts without repeating project guidance.

Wait for each result before sending follow-up work. Verify progress and correct quick fixes or wrong architecture. Before 89% context use, require a handoff.md preserving decisions, changed files, checks, blockers, and next actions, then continue with a new named worker. Do not mention supervision unless it affects the task.

Stop when feasible scope and relevant validation/docs are complete or a material decision/external blocker is documented. Commit only if explicitly requested.`;

export const API_REVIEW_SNIPPET = `Before implementing, review the API and architecture.

Focus on preventing the common failure mode: adding a plausible abstraction before proving it is the simplest clean end-state.

Check:

1. Smallest end-state shape: what is the simplest API shape that satisfies the real use cases? Can this be a concrete type/function before it becomes a trait, facade, callback wrapper, provider abstraction, or plugin seam?
2. State ownership and boundaries: what state is durable/shared vs per-session/per-evaluation/per-call? Is runtime/temporary state leaking into durable objects?
3. No alternate semantics: do fast paths, trusted paths, local shortcuts, caches, or materialized views preserve the same semantic contract, or explicitly name their different authority contract?
4. Naming matches reality: which stale names should be removed now rather than carried as compatibility?
5. Compatibility/shim pressure: is any layer being kept only to avoid editing call sites? Would deleting the old shape make the design clearer?
6. User decision points: what choice materially affects public API, persistence, protocol semantics, or long-term architecture?

Return the recommended shape, avoided abstractions/shims, state ownership, semantic risks, names to remove/rename, and material questions. Preserve required evidence and caveats; omit introductions and repetition. Do not implement until this review is done.`;

export const ENRICH_SNIPPET = `Perform an enrichment pass only. Do not implement source changes or authority-doc changes.

Read the relevant required-reading, handoff, plans, and current code/docs for this topic. If you write or materially change a plan, use delegate with context='clean' for a generic review before finishing, then triage the review in the same pass: apply clearly good suggestions, ignore bad ones, and split real unresolved questions into needs-decision with a scratch/decisions artifact.

Return the factual state with file references, stale/contradictory docs, open design questions, local versus human decisions, overcomplication risks, and the exact workboard.md update. Preserve evidence, caveats, blockers, and next actions; omit introductions and repetition. Usually move executable work to ready and material unresolved choices to needs-decision.

Separate facts, inferences, and guesses. Do not edit source code or authority docs during enrichment.`;

export const DISTILL_SNIPPET = `Before finishing, distill durable facts from this work.

Update required-reading/spec/AGENTS only with current factual state.
Move mutation plans/status/history into ordinary root docs or delete them if obsolete.
Remove stale compatibility language, old names, and misleading transitional docs.

Report the durable facts recorded, obsolete docs removed or updated, remaining non-durable plans, uncertainty, and next actions. Omit introductions and repetition.`;

export const SNIPPETS: PromptSnippet[] = [
  {
    key: "principles",
    value: PRINCIPLES_SUFFIX,
    description: "Insert the design principles suffix",
  },
  {
    key: "edit-principles",
    value: EDIT_PRINCIPLES_SUFFIX,
    description: "Insert the writing and editing principles suffix",
  },
  {
    key: "cut",
    value: CUT_SUFFIX,
    description: "Insert the cut/framing suffix",
  },
  {
    key: "simplify",
    value: SIMPLIFY_SUFFIX,
    description: "Insert the simplification/deletion review suffix",
  },
  {
    key: "delegate-review",
    value: DELEGATE_REVIEW_SUFFIX,
    description: "Insert the project delegate review suffix",
  },
  {
    key: "ts",
    value: TS_SUFFIX,
    description: "Insert the thoughts/suggestions suffix",
  },
  {
    key: "delegate-progress",
    value: DELEGATE_PROGRESS_SNIPPET,
    description: "Insert inherited delegate progress instructions",
  },
  {
    key: "supervise",
    value: SUPERVISE_SNIPPET,
    description: "Insert coding-agent supervisor instructions",
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
