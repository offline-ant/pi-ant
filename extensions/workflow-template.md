# Workflow

Editable policy for choosing and preparing work from `workboard.md`. The
workboard contains active workflow state, not cold ideas or design authority.
Keep unpromoted ideas in a separate backlog and durable facts in authority docs.

## Select work

If the user did not name an item, choose the first runnable non-empty section:

1. `needs-enrichment`
2. `ready`
3. `implementing`
4. `needs-distill`

`needs-decision` is blocked: return `REQUIRE_HUMAN_DECISION` while a human
signal is still required. `previous-done` is never runnable. Return
`EMPTY_WORKBOARD` when neither runnable work nor a pending decision remains.

Select the next task or stop condition; do not implement source changes during
guidance. Use the lightest workflow that completes the work safely. Create
plans, artifacts, reviews, or subagents only when they reduce risk, preserve
needed context, or enable broad work to finish.

Treat a previous ugo-do reflection as advisory. Promote a relevant cleanup,
simplification, wrong boundary, or follow-up into the appropriate workboard
update; otherwise ignore it.

## Route complexity

Choose one mode:

1. **Direct execution** — clear, small, low-risk work. Emit an executable prompt
   that makes the change, validates it, and updates `workboard.md`.
2. **Plan then execute** — sequencing matters but uncertainty is low. State the
   plan and execute it in one pass unless a real blocker appears; avoid a
   separate artifact for a short-lived plan.
3. **Plan, review, execute** — public API, persistence, protocol, architecture,
   security boundaries, durable naming, authority docs, or broad cross-file
   work. Write/update a plan under `scratch/`, review it with `minitask`, triage
   the review, then execute if sound. Apply good feedback, reject bad feedback,
   and move material unresolved choices to `needs-decision` with an artifact.
4. **Supervise workers** — broad, phaseable, parallelizable, or context-heavy
   work. Drive serial or parallel workers as appropriate, verify each result,
   preserve a handoff before context rollover, and stop only when complete or
   blocked on a material human decision or documented external dependency.

Escalate when state ownership, semantics, security, long-term architecture,
durable terminology, multiple packages/phases, or context rollover make direct
execution risky. Do not escalate routine implementation judgment. Require human
input only for choices that materially affect API, persistence, protocol,
product behavior, naming, security boundaries, or project direction.

## Emit the outcome

- `CONTINUE_WORK`: emit a directly executable `nextPrompt` with relevant files,
  required constraints, evidence/checks, success criteria, and the exact
  `workboard.md` transition before return.
- `UPDATE_WORK`: emit the exact `workboardUpdate` when an item is complete,
  obsolete, or needs bookkeeping only.
- `REQUIRE_HUMAN_DECISION`: create a `scratch/decisions/<slug>.md` artifact and
  emit choices. Do not include a worker prompt or workboard update.
- `EMPTY_WORKBOARD`: write no artifact and include no choices or work request.

A worker prompt must end in one accurate state:

- done: move the item to `previous-done`, replacing the old entry;
- human decision: move it to `needs-decision` and link the decision artifact;
- missing context/plan: move it to `needs-enrichment` with the exact gap;
- durable cleanup remains: move it to `needs-distill` with the required facts;
- executable remainder: move it to `ready` with a smaller task list;
- external blocker: use the most accurate section and record blocker plus retry
  condition.

Preserve required facts, decisions, evidence, caveats, blockers, checks, and
next actions. Omit introductions, repetition, reassurance, and optional
background first.

## Task-specific policy

### Enrichment

Inspect required reading, handoffs, plans, code, and docs. Do not change source
or authority docs. If a plan is written or materially changed, review it with
`minitask` and triage the result in the same pass.

Return factual state with file references, stale or contradictory docs, open
design questions, local versus human decisions, overcomplication risks, and the
exact workboard update. Separate facts, inferences, and guesses.

### Supervision

Give each worker only its task-specific context, files, extra constraints, and
handoff facts. Run dependent or overlapping work serially; parallelize only
independent work. Verify results before the next phase. A rollover handoff must
retain decisions, changed files, checks, blockers, and next actions. Avoid quick
fixes, compatibility shims, duplicate mechanisms, stale names, and abstractions
without a demonstrated use.

### Distillation

Move current durable facts into required-reading/spec/AGENTS or equivalent
authority docs. Update or remove stale names, compatibility language, temporary
plans, status, and history. Report recorded facts, removed/updated docs,
remaining temporary plans, uncertainty, and next actions.

### Human decisions

Use `scratch/decisions/<slug>.md` only for `REQUIRE_HUMAN_DECISION`. Include the
question, relevant context/files, options, recommendation, consequences, and an
empty `Human response` section. Tell the human to add `DONE: <decision>` or
`CLARIFY: <request>`; do not add either as a placeholder. Never use a decision
artifact for empty work, terminal status, or bookkeeping. Present substantial
decisions through `present_guidance`, not `ask`.
