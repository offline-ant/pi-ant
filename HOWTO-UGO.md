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
`needs-review`, `needs-enrichment`, and `needs-distill`. Ugo repeatedly asks a
fresh pi session to choose the next runnable workboard item, then asks another
fresh pi session to do the selected work.

It has two phases:

1. **guide phase**: read `workboard.md`, choose the next runnable item, and
   produce the exact do prompt for that item.
2. **do phase**: run that do prompt, or in manual mode prefill it for the user
   to edit/submit.

Personally, i used the /pi-prompt to reflect on how i was using my LLM in a loop. 



## Commands

```text
/ugo [auto|manual] [max=N]
/ugo-continue
/ugo-disable
/ugo-status
```

Defaults: `manual`, `max=20`.

Examples:

```text
/ugo
/ugo manual
/ugo auto
/ugo auto max=5
```

Starting ugo requires:

- `workboard.md` exists;
- current directory is a git repository;
- git worktree is clean.

Ugo always commits after each guide or do phase if files changed. The diff is
the repo change; the commit message records the guidance item/reason, prompt,
session, and agent result. If commit fails, ugo pauses.

`/ugo-disable` disables loop control without aborting the current agent turn. Use
Escape to abort the active turn.

## The loop ugo replaces

Without ugo, the same workflow is roughly this shell loop:

```bash
while true; do
  guide_result=$(pi -p '
    Read workboard.md.
    Choose the first runnable non-empty item from:
      needs-enrichment, ready, implementing, needs-review, needs-distill.
    Based on the item section and current context, write the exact next prompt
    that another pi -p run should execute.
    Return STALLED if there is no runnable item or a decision is needed.
  ')

  status=$(extract_status "$guide_result")
  if [ "$status" = STALLED ]; then
    break
  fi

  if [ "$status" = DONE ]; then
    do_prompt=$(make_workboard_update_prompt "$guide_result")
  else
    do_prompt=$(extract_next_prompt "$guide_result")
  fi

  pi -p "$do_prompt"
  git add -A && git commit -m "ugo: checkpoint with guide/do context"
done
```

Ugo runs that loop inside interactive pi instead of a blind shell. That gives the
user visibility and control: each guide/do phase is a normal pi session, manual
mode lets the user edit the do prompt before submitting, Escape aborts the active
turn, and `/ugo-disable` prevents the next phase.

## How guide chooses the do prompt

The guide phase is responsible for converting workboard state into a do prompt.
It sees `workboard.md` and uses this runnable section order:

```text
needs-enrichment -> ready -> implementing -> needs-review -> needs-distill
```

The selected section shapes the prompt it emits:

- `needs-enrichment`: produce a context-gathering prompt; usually use the
  enrichment primitive and do not implement yet.
- `ready`: produce an implementation/execution prompt.
- `implementing`: produce a continuation prompt using the current handoff/status.
- `needs-review`: produce a review prompt; often include the mini-review pattern.
- `needs-distill`: produce a durable-facts cleanup/distillation prompt.

Every emitted do prompt must tell the do phase how to update `workboard.md`
before finishing. Typical outcomes are moving the item to `done`,
`needs-review`, `needs-decision`, `needs-distill`, or back to `ready` with a fix
list.

The guide phase communicates its decision by calling `present_guidance`.

## Modes

### manual

Default. Ugo runs a guide phase, creates the do-phase session, and pre-fills the
editor with the do prompt. You edit or submit it manually. After the do turn
finishes, pi pre-fills:

```text
/ugo-continue
```

Submitting it starts the next guide phase.

### auto

Runs continuously until `STALLED`, `max=N`, commit failure, Escape, or disable:

```text
guide -> do -> guide -> do -> ...
```

## State transitions and prompts

### Start guide phase

State:

```text
phase = guide
present_guidance enabled
```

Prompt sent to the LLM:

```text
Investigate the lowest runnable item in workboard.md and call present_guidance with the result.
```

If there was a previous guidance result, the prompt becomes:

```text
Investigate the lowest runnable item in workboard.md and call present_guidance with the result.

Previous guidance result for context:
<pi-guidance-result>
{ ...previous guidance JSON... }
</pi-guidance-result>
```

### `present_guidance`: CONTINUE

Tool input:

```json
{
  "status": "CONTINUE",
  "item": "workboard item title",
  "reason": "why this is the next step",
  "nextPrompt": "exact do prompt; must include how to update workboard.md"
}
```

Transition:

```text
guide -> do
doPrompt = nextPrompt
```

Do prompt sent or prefilled:

```text
${guidance.nextPrompt}
```

### `present_guidance`: DONE

Tool input:

```json
{
  "status": "DONE",
  "item": "workboard item title",
  "reason": "why the item is complete or obsolete",
  "workboardUpdate": "exact requested workboard.md update"
}
```

Transition:

```text
guide -> do
doPrompt = generated workboard-update prompt
```

Do prompt:

```text
Apply this workboard.md update only.
Do not change source code or authority docs.
Edit workboard.md so it reflects the requested state change.
If workboard.md does not exist, report that and stop.
Before finishing, say exactly what changed in workboard.md.

Requested update:
${guidance.workboardUpdate}
```

### `present_guidance`: STALLED

Tool input:

```json
{
  "status": "STALLED",
  "item": "blocked item or no runnable item",
  "reason": "why automation should stop",
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

For decision stalls, guide should write a concise decision artifact under
`scratch/decisions/` with the question, relevant context/files, options,
recommendation, consequences, and a human response section. The human can write
one of these lines in `workboard.md` or any `scratch/decisions/*` file:

```text
DONE: <decision>
CLARIFY: <missing context or request>
```

Decision artifacts must not include active `DONE:` or `CLARIFY:` placeholder
lines; leave the response blank until the human writes the signal.

Transition:

```text
guide -> stalled -> watch workboard.md and scratch/decisions/*
```

When ugo sees `DONE:`, it runs a workboard-only do phase that moves the matching
`needs-decision` item to `ready` unless the signal names another runnable
section. When it sees `CLARIFY:`, it moves the matching item to
`needs-enrichment`. Then ugo commits and starts the next guide phase.

If you manually edit `workboard.md` instead, submit `/ugo-continue` to run the
next guide phase.

### Do phase finishes

In `auto` mode:

```text
do -> guide
```

In `manual` mode:

```text
do -> wait for /ugo-continue
```

If `/ugo-disable` was run while the do phase was active:

```text
do finishes -> disabled
```

No commit or next guide phase is started after disable.

## Minimal example

Initial `workboard.md`:

```md
## ready

- Add hello file.
  - Create `hello.txt` containing `hello`.

## done

-
```

Start:

```text
/ugo auto max=3
```

Guide phase calls:

```json
{
  "status": "CONTINUE",
  "item": "Add hello file",
  "reason": "The ready item is concrete and has enough context.",
  "nextPrompt": "Implement the ready workboard.md item \"Add hello file\". Create `hello.txt` containing exactly `hello` followed by a newline. Then update workboard.md by moving \"Add hello file\" from ready to done with a concise note. Finish by reporting changed files."
}
```

Do phase receives exactly that `nextPrompt`, creates `hello.txt`, updates
`workboard.md`, and reports the result.

Ugo commits the do-phase diff with a message shaped like:

```text
ugo: Add hello file

Ugo phase: do
Ugo iteration: 1
Ugo mode: auto
Session: <session file>

Guidance:
Status: CONTINUE
Item: Add hello file
Reason: The ready item is concrete and has enough context.

Prompt:
<do prompt>

Agent result:
<last assistant response>
```

The next guide phase sees the updated workboard. If nothing runnable remains, it
calls `STALLED` and ugo stops.
