# Workflow

This file defines how guidance sessions choose and prepare work from `workboard.md`.
Edit this file to change the workflow policy for this repository.

`workboard.md` is active workflow state, not a cold idea backlog. Put
unpromoted ideas in a project `backlog.md`, `ideas.md`, or equivalent file
outside `workboard.md`; promote them into `workboard.md` only when you want an
agent to act on them.

## Guidance role

Inspect `workboard.md` and linked files, then choose the next clean workflow
outcome. Select the next task or stop condition; do not implement source changes
during guidance.

Use the lightest workflow that can complete the work cleanly. Do not create
process, plans, artifacts, subagents, or bookkeeping unless they reduce risk,
preserve useful context, enable review, or help drive broad work to completion.

Use clear stopping points over vague autonomy. If human input is needed, write
enough context for the human to decide without rereading the whole session.

## Workboard sections

If the user did not name an item, choose the first runnable non-empty workboard
item in this order:

1. `needs-enrichment`
2. `ready`
3. `implementing`
4. `needs-distill`

`needs-decision` is blocked on human input. If a `needs-decision` item still
needs a human signal, return `REQUIRE_HUMAN_DECISION`.

`previous-done` is never runnable. If no runnable or human-decision item
remains, return `EMPTY_WORKBOARD` with no artifact, choices, `nextPrompt`, or
`workboardUpdate`.

Treat cold ideas/backlog items outside `workboard.md` as not runnable until a
human promotes them into `workboard.md`.

## Complexity router

After selecting an item, choose the lightest sufficient mode:

1. Direct execution
   - Use when the task is clear, small, and low-risk.
   - Generate a worker prompt that does the work directly and updates
     `workboard.md` before finishing.
   - Do not ask for a plan file or subagent review.

2. Plan then execute
   - Use when sequencing matters, several files may change, or there are a few
     known steps, but uncertainty is low.
   - Generate a prompt that first states the short plan, then executes it in the
     same pass unless a real blocker appears.
   - A separate plan artifact is optional; avoid it for short-lived plans.

3. Plan file + review + execute
   - Use when public API, persistence, protocol semantics, architecture,
     cross-cutting names, authority docs, or many files are involved.
   - Generate a prompt that writes or updates a concise plan/handoff file under
     `scratch/`, asks `minitask` for a generic review of the plan before
     execution, triages that review in the same pass, then executes if the plan
     is sound.
   - Apply clearly good review suggestions, ignore bad ones, and move real
     unresolved choices to `needs-decision` with a `scratch/decisions/` artifact.

4. Supervise/subagents + handoffs
   - Use when the work is broad, phaseable, parallelizable, likely to exceed one
     context, or benefits from independent implementation agents.
   - Generate a controller prompt that drives subagents through phases, verifies
     returned work, requires concise handoffs when context rolls over, and stops
     only when the work is complete or blocked on a real human decision.
   - The controller should not tell workers they are being supervised unless that
     matters for the task.

Planning is conditional, not default. If the next action is obvious, execute it.
If context is missing, enrich only enough to make the next execution step safe.

## Escalation triggers

Escalate from direct execution to planning/review/supervision when one or more
of these are true:

- The task touches public API, persistence format, protocol semantics,
  authority docs, security boundaries, or long-term architecture.
- The task crosses many files, packages, languages, or independently testable
  phases.
- Naming or product terminology may become durable.
- There is risk of adding a compatibility shim, abstraction, cache, fast path,
  or fallback before proving it is the simplest end state.
- The work is likely to exceed one context window or require a handoff.
- A plan would let a reviewer catch design mistakes before implementation.

Require a human decision only when a choice materially affects long-term API,
semantics, product behavior, persistence, protocol, naming, or project direction.
Do not stop for routine implementation judgment the agent can decide locally.

## Outcome policy

- `CONTINUE_WORK`: there is a concrete next prompt to run. `nextPrompt` is
  required and must be directly executable by the next worker.
- `UPDATE_WORK`: the selected item is complete, obsolete, or only needs
  workboard bookkeeping. `workboardUpdate` is required and should say exactly
  how to update `workboard.md`.
- `REQUIRE_HUMAN_DECISION`: progress requires human input. `choices` and a
  `scratch/decisions/<short-slug>.md` artifact are required. Do not include
  `nextPrompt` or `workboardUpdate`.
- `EMPTY_WORKBOARD`: no runnable work or pending decision remains. Do not write
  artifacts and do not include choices, `nextPrompt`, or `workboardUpdate`.

If an item is obsolete or already completed, return `UPDATE_WORK` with a precise
`workboardUpdate` that removes it or replaces `previous-done` with the latest
completed item.

## Prompt-selection rules

Use the workboard section as the initial hint, then apply the complexity router.

- `needs-enrichment`: produce an enrichment prompt only when context gathering,
  planning, or decision framing is actually needed before safe execution.
- `ready`: produce the lightest sufficient execution prompt: direct execution,
  plan-then-execute, plan-review-execute, or supervise/subagents.
- `implementing`: produce a continuation prompt using the current handoff/status;
  escalate to supervision only if the current worker needs phase/control help.
- `needs-distill`: produce a durable-facts cleanup prompt.

If durable facts need to be moved into authority docs before more work, prefer a
`needs-distill`-style prompt. If the item lacks enough context, prefer a focused
enrichment prompt. For broad items, choose the next small stage instead of the
whole effort unless supervisor mode is the right way to drive all phases.

Keep `nextPrompt` specific: include relevant files, constraints, what to do,
checks/reports expected when relevant, and the required `workboard.md` update.
Do not say only "continue" or "do the next step".

Every `CONTINUE_WORK` `nextPrompt` must tell the next worker exactly how to
update `workboard.md` before finishing. It should say which section to move the
item to for likely outcomes such as `needs-decision`, `needs-distill`,
`previous-done`, or back to `ready` with a concrete remaining-work list.

## Finish shapes

Every worker prompt should finish by making the state explicit. The worker should
choose exactly one shape before returning:

- Done: move the item to `previous-done` and replace any old `previous-done`
  entry.
- Needs human decision: move the item to `needs-decision` and create/link a
  `scratch/decisions/<short-slug>.md` artifact.
- Needs more context/planning: move the item to `needs-enrichment` with the exact
  missing context or planning target.
- Needs distillation: move the item to `needs-distill` with the durable facts or
  stale docs that need cleanup.
- Still ready: move it back to `ready` only with a concrete, smaller remaining
  task list.
- Blocked externally: keep or move it to the most accurate section and record the
  exact blocker and retry condition.

## Enrichment primitive

Use this when the selected item needs context gathering or plan shaping before
execution. Do not implement source changes or authority-doc changes.

Read the relevant required-reading, handoff, plans, and current code/docs for
this topic. If you write or materially change a plan, ask `minitask` for a
generic review of the plan before finishing, then triage the review in the same
pass: apply clearly good suggestions, ignore bad ones, and split real unresolved
questions into `needs-decision` with a `scratch/decisions/` artifact.

Return with:

1. Current factual state with file references.
2. Stale or contradictory docs.
3. Open design questions, with decision artifacts for questions needing human
   input.
4. What can be decided now vs what needs user input.
5. Risks of overcomplication or stale compatibility.
6. How `workboard.md` was updated: usually move executable enriched work to
   `ready`, or move blockers to `needs-decision`.

Separate facts, inferences, and guesses. Do not edit source code or authority
docs during enrichment.

## Supervisor primitive

Use this for broad work that needs subagents or multiple phases. The generated
controller prompt should say:

- Drive the task to completion through serial or parallel subagents as
  appropriate.
- Give each subagent only task-specific context, relevant files, constraints,
  and handoff notes.
- For dependent tasks or tasks touching the same files, run workers serially.
- Verify returned work before launching the next phase.
- Watch context size; if a worker is near context rollover, require a concise
  `handoff.md` and continue from that handoff.
- Keep architecture quality high: avoid quick fixes, compatibility shims,
  duplicate mechanisms, stale names, and overbroad abstractions.
- Stop only when the work is complete, a real human decision is needed, or an
  external blocker is documented.
- Update `workboard.md` according to the finish shapes before returning.

## Distill primitive

Use this when work is done or mostly done but durable facts need to move into
authority docs and temporary planning/status needs cleanup.

Before finishing, distill durable facts from this work.

Update required-reading/spec/AGENTS only with current factual state. Move
mutation plans/status/history into ordinary root docs or delete them if obsolete.
Remove stale compatibility language, old names, and misleading transitional docs.

Then report:

- durable facts recorded,
- obsolete docs removed/updated,
- remaining non-durable plans,
- anything still uncertain.

## Human decisions

For human decisions, write a concise decision artifact under
`scratch/decisions/<short-slug>.md` with:

- question,
- relevant context/files,
- options,
- recommendation,
- consequences,
- a final "Human response" section.

Tell the human to write `DONE: <decision>` when resolved or
`CLARIFY: <missing context/request>` when more enrichment is needed. Do not
include an active line starting with `DONE` or `CLARIFY` as a placeholder;
leave the response blank until the human writes the signal.

Decision artifacts must never be used for no-work, empty-workboard, terminal
status, or bookkeeping notes. `scratch/decisions/` is only for
`REQUIRE_HUMAN_DECISION`.

Do not use `ask` for substantial decisions; present decision choices through
`present_guidance`.
