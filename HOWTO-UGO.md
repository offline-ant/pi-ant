# Problem:

After using /prompt-history i reflected on my workflow and it boiled down to:

- idea -> implement
- idea -> plan -> implement
- idea -> plan -> reviewed -> implemented
- idea -> plan -> reviewed -> implement using subagents
- idea -> plan { -> review } -> found issue -> try and understand context and receive questions from the LLM (using the `ask` tool)

And a lot of wrangling to keep docs up to date.
Keeping the docs up to date was an issue of setting AGENTS.md for the most part.

ugo :

- Organizes status of an idea & their dependencies in a single file. (Note that 'idea' means something 'i want to implement right now' not 'backlog').
- Generates a prompt for every `->` (and can automatically use them)
- Automates more of the `try and understand context` and watches the text file explaining it for 'DONE' or 'CLARIFY'.

# Ugo HOWTO

`/ugo` is a workboard runner for interactive pi.

A project workboard is a `workboard.md` file with sections like `ready`,
`needs-enrichment`, `needs-decision`, and `needs-distill`. It is active workflow
state, not a cold idea backlog. Put unpromoted ideas in a project `backlog.md`,
`ideas.md`, or equivalent file outside `workboard.md`; promote them into
`needs-enrichment` when you want investigation/planning or `ready` when you want
execution. The editable guidance policy lives in `workflow.md`; `/ugo` creates
it with the default policy when missing. Ugo repeatedly asks a fresh pi session
to choose the next runnable workboard item, then asks another fresh pi session
to do the selected work.

It has two phases:

1. **ugo-guide phase**: read `workboard.md`, load editable `workflow.md`, choose
   the next workflow outcome, and produce structured guidance for it.
2. **ugo-do phase**: run a worker or workboard-update prompt when guidance
   returns one. After every ugo-do main result, ugo automatically runs a
   no-tools reflection turn with `Retrospective` and `Simplify` notes, records
   it with the ugo-do result,
   and injects the complete reflection into the next ugo-guide prompt for
   workboard triage.

Personally, i used the /pi-prompt to reflect on how i was using my LLM in a loop.

## Commands

```text
/ugo
/ugo-pause
```

`/ugo` starts or resumes the automatic workboard loop. `/ugo-pause` requests a
safe pause without aborting the current agent turn.

Example:

```text
/ugo
```

Starting ugo requires:

- `workboard.md` exists;
- current directory is a git repository;
- `workflow.md` exists or can be created from the default policy;
- the git worktree has no dirty files except root `workboard.md`, root `workflow.md`, and files under root `scratch/`.

Ugo always commits after each ugo-guide or ugo-do phase if files changed. The
diff is the repo change; the commit message records the ugo-guide item/reason,
prompt, session, and ugo-guide/ugo-do result. Every ugo-do result includes an
automatic no-tools reflection section with `Retrospective` and `Simplify` notes.
The complete reflection is saved in ugo state and injected into the next
ugo-guide prompt so the guide can promote relevant improvements into
`workboard.md` updates/items. Ugo uses `git add -A` when checkpointing, so any
dirty files present when a phase finishes are included in the checkpoint commit.
If commit fails, ugo pauses.

`/ugo-pause` stops file watchers immediately and otherwise waits for the active
ugo-guide or ugo-do phase to finish and checkpoint before pausing. Use Escape to
abort the active turn.

## The loop ugo replaces

Without ugo, the same workflow is roughly this shell loop:

```bash
while true; do
  guide_result=$(PI_GUIDANCE=true pi -p '
    Read workboard.md, follow workflow.md, choose the next workflow outcome,
    and call present_guidance with the result.
  ')

  status=$(extract_status "$guide_result")
  if [ "$status" = "EMPTY_WORKBOARD" ] || [ "$status" = "REQUIRE_HUMAN_DECISION" ]; then
    break
  fi

  if [ "$status" = "UPDATE_WORK" ]; then
    do_prompt=$(make_workboard_update_prompt "$guide_result")
  else
    do_prompt=$(extract_next_prompt "$guide_result")
  fi

  pi -p "$do_prompt"
  git add -A && git commit -m "ugo: checkpoint with ugo-guide/ugo-do context"
done
```

Ugo runs that loop inside interactive pi instead of a blind shell. That gives the
user visibility and control: each ugo-guide/ugo-do phase is a normal pi session,
Escape aborts the active turn, and `/ugo-pause` prevents the next phase after a safe checkpoint.

## How ugo-guide chooses the next workflow outcome

The ugo-guide phase is responsible for converting workboard state into one of
four guidance outcomes: `CONTINUE_WORK`, `UPDATE_WORK`,
`REQUIRE_HUMAN_DECISION`, or `EMPTY_WORKBOARD`. It follows the editable policy in
`workflow.md`. The default policy uses this section order:

```text
needs-enrichment -> ready -> implementing -> needs-distill
```

The selected section shapes the prompt it emits:

- `needs-enrichment`: gather missing context without implementing. A new or
  materially changed plan must receive a `delegate` review with `context: "clean"` in the same pass;
  executable work moves to `ready`, while material unresolved questions move to
  `needs-decision` with a `scratch/decisions/` artifact.
- `ready`: emit the lightest safe implementation/execution prompt.
- `implementing`: continue from current status and handoff, escalating to
  supervised workers only when breadth or context requires it.
- `needs-distill`: move durable facts into authority docs and remove stale
  temporary state.

Every emitted ugo-do prompt must tell the ugo-do phase how to update
`workboard.md` before finishing. Typical outcomes are moving the item to
`previous-done`, `needs-decision`, `needs-distill`, or back to `ready` with a
fix list.

The ugo-guide phase communicates its decision by calling `present_guidance`.

## Loop control

Ugo runs continuously until `REQUIRE_HUMAN_DECISION`, `EMPTY_WORKBOARD`, commit failure, Escape, or `/ugo-pause`:

```text
ugo-guide -> ugo-do -> ugo-guide -> ugo-do -> ...
```

`/ugo` resumes from `paused`, `awaiting_decision`, or `empty` by starting the next ugo-guide phase. If ugo is already running, `/ugo` reports the current phase instead of starting a second loop.

`/ugo-pause` does not abort the active model turn. During ugo-guide it pauses after guidance is committed and before ugo-do. During ugo-do it pauses after the do result, reflection, and checkpoint commit. While waiting for a decision or an empty workboard edit, it stops the file watchers and marks ugo paused.

## State transitions and prompts

### Start ugo-guide phase

State:

```text
phase = ugo-guide
present_guidance enabled
```

Prompt sent to the LLM:

```text
Inspect workboard.md, follow workflow.md, choose the next workflow outcome, and call present_guidance with the result.
```

If there was a previous guidance result, the prompt also includes it:

```text
Previous guidance result for context:
<pi-guidance-result>
{ ...previous guidance JSON... }
</pi-guidance-result>
```

If there was a previous ugo-do reflection, the prompt also includes it:

```text
The previous ugo-do reflection was this:
<complete reflection response>

If it contains a relevant improvement, cleanup, simplification opportunity, or follow-up to apply, upgrade it into a new workboard.md item or precise workboard.md update according to workflow.md. Prefer needs-distill for cleanup/docs and ready for concrete code simplification. If it is not relevant now, ignore it.
```

### `present_guidance`: CONTINUE_WORK

Tool input:

```json
{
  "status": "CONTINUE_WORK",
  "item": "workboard item title",
  "reason": "why this is the next step",
  "nextPrompt": "exact ugo-do prompt; must include how to update workboard.md"
}
```

Transition:

```text
ugo-guide -> ugo-do
ugo-do prompt = nextPrompt
```

ugo-do prompt sent or prefilled:

```text
${guidance.nextPrompt}
```

### `present_guidance`: UPDATE_WORK

Tool input:

```json
{
  "status": "UPDATE_WORK",
  "item": "workboard item title",
  "reason": "why only workboard bookkeeping is needed",
  "workboardUpdate": "exact requested workboard.md update"
}
```

Transition:

```text
ugo-guide -> ugo-do
ugo-do prompt = generated workboard-update prompt
```

ugo-do prompt:

```text
Apply this workboard.md update only.
Do not change source code, authority docs, or workflow.md.
Edit workboard.md so it reflects the requested state change.
If workboard.md does not exist, report that and stop.
Before finishing, say exactly what changed in workboard.md.

Requested update:
${guidance.workboardUpdate}
```

### `present_guidance`: REQUIRE_HUMAN_DECISION

Tool input:

```json
{
  "status": "REQUIRE_HUMAN_DECISION",
  "item": "blocked item",
  "reason": "why a human decision is required",
  "artifact": "scratch/decisions/<short-slug>.md",
  "choices": [
    {
      "label": "option label",
      "description": "optional decision context",
      "recommended": true
    }
  ]
}
```

For human decisions, ugo-guide writes a decision artifact under
`scratch/decisions/` containing the question, required context/files, options,
recommendation, material consequences, and a human response section. The human can write
one of these lines in `workboard.md` or any `scratch/decisions/*` file:

```text
DONE: <decision>
CLARIFY: <missing context or request>
```

Decision artifacts must not include active `DONE:` or `CLARIFY:` placeholder
lines; leave the response blank until the human writes the signal. Decision
artifacts must never be used for no-work, empty-workboard, terminal status, or
bookkeeping notes.

Transition:

```text
ugo-guide -> awaiting_decision -> watch workboard.md and scratch/decisions/*
```

When ugo sees `DONE:`, it runs a workboard-only ugo-do phase that moves the
matching `needs-decision` item to `ready` unless the signal names another
runnable section. When it sees `CLARIFY:`, it moves the matching item to
`needs-enrichment`. Then ugo commits and starts the next ugo-guide phase.

If you manually edit `workboard.md` instead, submit `/ugo` to run the next ugo-guide phase.

### `present_guidance`: EMPTY_WORKBOARD

Tool input:

```json
{
  "status": "EMPTY_WORKBOARD",
  "item": "workboard.md",
  "reason": "no runnable work or pending human decision remains"
}
```

`EMPTY_WORKBOARD` means there is simply nothing for ugo to do. It must not
include `artifact`, `choices`, `nextPrompt`, or `workboardUpdate`, and ugo-guide
must not write a `scratch/decisions/` artifact for it.

Transition:

```text
ugo-guide -> empty -> watch workboard.md
```

Ugo remains active while empty. When `workboard.md` changes and only
`workboard.md`/`workflow.md`/`scratch/` paths are dirty, ugo starts the next
ugo-guide phase. You can also submit `/ugo` after editing `workboard.md` or
`workflow.md`.

### ugo-do phase finishes

Ugo first runs an automatic no-tools reflection turn for the ugo-do result. The
reflection cannot call tools and must return two labeled notes:

```text
- Retrospective: wrong-shape direction, missed design choice, or process/plan issue.
- Simplify: cleanup/simplification opportunities observed while doing the work.
```

Ugo appends the reflection to the ugo-do result for the checkpoint commit. The
complete reflection is also injected into the next ugo-guide prompt; the guide
decides whether it is relevant enough to become `workboard.md` updates or items.

Default completion path:

```text
ugo-do -> ugo-do reflection -> ugo-guide
```

If `/ugo-pause` was requested while the ugo-do phase was active:

```text
ugo-do -> ugo-do reflection -> paused
```

The do result and reflection are still committed before the pause takes effect.

## Minimal example

Initial `workboard.md`:

```md
## ready

- Add hello file.
  - Create `hello.txt` containing `hello`.

## previous-done

-
```

Start:

```text
/ugo
```

ugo-guide phase calls:

```json
{
  "status": "CONTINUE_WORK",
  "item": "Add hello file",
  "reason": "The ready item is concrete and has enough context.",
  "nextPrompt": "Implement the ready workboard.md item \"Add hello file\". Create `hello.txt` containing exactly `hello` followed by a newline. Then update workboard.md by moving \"Add hello file\" from ready to previous-done with its outcome and changed file, replacing any existing previous-done entry. Finish by reporting changed files."
}
```

ugo-do phase receives exactly that `nextPrompt`, creates `hello.txt`, updates
`workboard.md`, and reports the result.

Ugo commits the ugo-do diff with a message shaped like:

```text
ugo: Add hello file

ugo-do phase
ugo loop iteration: 1
Session: <session file>

ugo-guide result:
Status: CONTINUE_WORK
Item: Add hello file
Reason: The ready item is concrete and has enough context.

ugo-do prompt:
<ugo-do prompt>

ugo-do result:
<last assistant response>

---

Reflection:
- Retrospective: <retrospective response>
- Simplify: <simplify response>
```

The next ugo-guide phase sees the updated workboard and the complete reflection.
If nothing runnable or pending decision remains, it calls `EMPTY_WORKBOARD` and
stays active while watching `workboard.md` for new work.
