# <Project name>

<One or two sentences: what this project enables. Point to the documents that
own its design, commands and layout instead of restating them.>

## Reading and documentation

- Read affected projects' instructions, required documents and files completely
  before editing or relying on them. Report what you read and any
  discrepancies; do not invent behavior.
- Local restrictions apply to their own project. Resolve relative paths from
  the document's source directory.
- Keep each subject in one owning document; link instead of copying. Update
  affected documents in the same change. Current-state docs describe the
  current state, not its history.

## Development principles

- Optimize for the smallest clean long-term design; treat the cost of change as
  zero. Code and prose you add beyond the task cannot be wrong if not written:
  delete stale material instead of deprecating or annotating it.
- Implement direct final states: no compatibility code, aliases, migrations,
  shims or parallel mechanisms unless requested.
- Do the hard part first. Add a choice, mechanism, abstraction or defensive
  branch only once its need is established; a request or accepted plan
  establishes it, consumer count does not. Generality is not complexity: a
  general design no larger than the special case is the simpler one.
- Make only requested or clearly necessary changes. Ask before removing
  apparently intentional functionality.
- Where failure is a valid outcome, fail explicitly through the existing
  cleanup path. Settle owned resources, preserve original and cleanup errors,
  and never present uncertainty as success.
- Fix warnings by cleanup, not suppression.
- Name concepts for their actual role. Ask before inventing terminology,
  compatibility behavior, authority or ownership boundaries.

## Style and tests

- Keep prose technical and concise.
- Keep source files under 1000 lines; split before 1500.
- Run the smallest meaningful checks, including changed tests. Prefer
  boundary-crossing tests in test files; skip tests for obvious behavior.
- Each test finishes within 20 seconds; test commands time out within 60.
  Explicitly marked long tests stay out of the default run. Inject tiny limits
  or a paused clock instead of waiting out deadlines.
- Wait on readiness or events, not fixed delays.
- Use `uv` for Python dependency, environment, build and test work.
- Prefer `rg` over `grep`/`find`.

## Git and safety

- Other agents may work concurrently: touch only task-relevant files and
  preserve others' changes.
- Commit only when asked, staging explicit paths.
- No destructive git commands (`reset --hard`, `checkout .`, `clean`, `stash`,
  force push) without approval.
- Create worktrees under the ignored `worktrees/` folder; remove them when done.
- Never commit or print secrets. Get approval before disruptive operations on
  live systems or data.

## Agent behavior

- Verify instead of assuming; check outcomes before claiming success.
- Ask when ambiguity affects scope, safety or a material decision. Answer
  questions before editing.
