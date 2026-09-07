# Shared orchestration across tmux, Herdr, and Emacs

Status: design proposal; no implementation or active settings changes.

## Decision

One Pi orchestration package, one worker implementation, three small host
adapters. A host owns where a child runs and how its output is presented. It
does not decide task context, tool policy, completion, or retrospective behavior.

This supersedes the initial Emacs-only proposal. Supporting all three hosts is
now an explicit requirement, not a speculative backend abstraction. There is
no reason to build a separate Emacs-owned worker scheduler.

## Evidence in the current code

The tmux and Herdr `extensions/coding-agent.ts` implementations share nearly
the same persistent registry, exclusive name claim, session creation, worker
request construction, result waiting, and result formatting.

Their `worker-frame.ts` implementations also duplicate result/status artifacts,
result ID validation, progress reporting, and the result/retrospective lifecycle.
Herdr's current version has newer supervision and settled-retry behavior; use
that behavior as the common baseline, not a merger of both generations.

The actual host-specific work is:

- Start a shell command or Pi session with a cwd and environment.
- Submit input to the correct running target.
- Read bounded output for capture and progress previews.
- Determine whether the managed process still exists or has exited.
- Close the managed target and clean up its process.

## Package shape

```text
orchestration/
  extensions/              # delegate, coding-agent, panel tools, fork command
  workers.ts               # common execution and persistent worker registry
  worker-frame.ts          # common child task/supervision/retrospective policy
  context.ts               # inherited/project/clean/history session preparation
  host.ts                  # small interface and host selection
  hosts/
    tmux.ts
    herdr.ts
    emacs.ts
  emacs/
    pi-orchestration.el    # native session/process operations, no worker scheduler
```

This is a responsibility sketch, not a requirement to create every file before
it has enough code to justify existing. No backend plugin registry, capability
negotiation framework, or provider class hierarchy.

Use one set of public tool names on every host: `delegate`, `coding-agent`,
`fresh-history`, and neutral `panel-start`, `panel-read`, `panel-send`,
`panel-close`. Ordinary foreground `bash` stays Pi's built-in tool.
Expose interactive forking as `/fork-here`, a user slash command rather than
another LLM-callable delegation tool. It replaces `/herdr-fork` and the old
`/tmux-fork` command without keeping backend-specific aliases.

Old tmux `call` and `minitask` overlap the current delegate context modes; do
not restore their names, old model fallbacks, or old state formats merely to
support tmux again. Backend support is not backwards compatibility with the
old tmux package's complete public API.

## Interactive fork and related commands

`/fork-here [name] [folder] [-- <prompt>]` creates an independent interactive
Pi session on the parent's selected host. “Here” means the current host and
workspace, with the parent's cwd by default; it does not replace the parent.
Retain the existing optional name, folder, and initial prompt behavior.

- Fork the active conversation branch using shared Pi session preparation.
- Inherit the current provider, model, thinking level, and applicable tool
  selection; give the child its own session file and host target.
- With no prompt, open idle. Preserve the parent's editor draft and session.
- Use a sibling pane in tmux/Herdr and a separate Pilish chat/input pair in
  Emacs. The host chooses native placement; expose no layout configuration.
- Unlike a delegate, the fork has no parent result wait, automatic retrospective,
  or automatic close. It is an independent conversation and may fork again,
  subject to the shared nesting policy.
- Keep Pi's built-in `/fork` unchanged: that navigates into a fork in the
  current process and is not the same operation.

All entry points call the same shared fork operation:

1. `/fork-here`, normally invoked while idle.
2. The existing fork shortcut, with native bindings in Pi TUI and Emacs.
3. `ask`'s “Fork (discuss separately)” action. Fork immediately before the active
   `ask` tool-call message, submit the discussion prompt in the new child, and
   leave the parent question and its selections intact. This path must work
   while the parent is waiting on that question; it cannot require parent idle.

The start contract therefore needs an explicit interactive-fork placement intent
as distinct from a background worker. This is a concrete existing requirement,
not a general window-layout abstraction. Identify the parent target explicitly;
placement must not depend on whichever pane/window happens to have focus.

Also retain host-neutral `/worker-submit`, `/worker-continue`, and
`/finish-worker-now` commands, and replace backend-specific panel listings with
`/panels`. During extraction, inventory the remaining commands and shortcuts:
keep current functionality that is still required, share its implementation,
and agree explicitly on intentional legacy features before removing them.
Do not invent additional commands merely for symmetry across hosts.

## Host contract

Conceptually:

```text
start(spec)              -> target
send(target, input)      -> acknowledgement
read(target, bounds)     -> output preview
state(target)            -> running / exited / missing
close(target)            -> acknowledgement
```

`start` has a typed shell/Pi distinction. The common layer prepares the Pi
session, model, thinking level, tools, and task; the adapter selects the native
launch mechanism. A Pi startup may include an initial prompt so the host can
submit it through its proper startup path instead of waiting for screen text.

`send` also distinguishes a Pi prompt from literal terminal text or a supported
control action. A single method is fine; one untyped string meaning either
text, key names, or an RPC command is not.

| Operation | tmux | Herdr | Emacs |
| --- | --- | --- | --- |
| Start Pi | Pi TUI in a managed pane | Named Herdr Pi agent | Named Pilish RPC session |
| Start shell | Managed shell pane | Managed shell panel | Native process/terminal buffer |
| Submit Pi prompt | Terminal submission | Named-agent prompt | Pilish RPC prompt |
| Read preview | Pane capture | Pane read | Chat/process buffer text |
| Liveness | Managed process/pane status | Agent/pane status | Emacs process status |
| Close | Close managed pane | Close managed agent/pane | Stop process and close owned buffers |

Targets carry native IDs internally. The common registry owns logical names;
callers do not parse `%12`, Herdr pane IDs, or Emacs buffer names. Store the
host identity with a target so a later change in environment cannot redirect
an operation to a different host. A surviving shell pane is not proof that
its Pi process is alive.

For the first common capture contract, bounded snapshots are sufficient for
worker previews. Do not promise exact incremental output by comparing rendered
snapshots: terminal redraw, scrollback eviction, and Emacs buffer rewriting
invalidate that guarantee. Lossless shell-log cursors require capturing output
at its source; treat that as a separately specified capture contract, not an
implicit property of `read`.

Readiness waiting is distinct from task completion. Keep readiness matching
behind the common panel operation; native host output-wait mechanisms can be
used where appropriate. Its timeout/error must retain target identity and
recent output for diagnosis.

## Shared worker protocol

The existing structured request/result artifacts already work independently
of terminal rendering. Extract one current implementation, with neutral names
and one current schema. Do not add an Emacs-specific worker protocol or
obsolete-format readers.

```text
delegate task
  -> prepare session and request
  -> host.start(Pi session)
  -> submit /worker-run request through the host's Pi-input path
  -> common wait:
       inspect structured worker state/result
       check host liveness
       host.read -> parent tool onUpdate preview
  -> matching result + retrospective
  -> close ephemeral target / retain persistent target
```

The child extension is responsible for task phase and human supervision on
all hosts. Pi APIs handle model/tool policy and provider retry/compaction.
The parent runner handles context preparation, name claims, waiting, result
formatting, and cancellation. The adapter only implements native operations.

A final result with the matching request ID is completion. A returned prompt
acknowledgement, disappearance of a spinner, empty capture, or process exit
without a result is not completion. Resolve failures after Pi's
`agent_settled`; do not port tmux's retry grace timer or startup-banner regexes.

The same bounded text and structured details go through `onUpdate` on every
host. Pi TUI and Pilish render that as the parent tool's progress. The complete
child conversation remains available in its own pane/buffer and session file.
No second child-transcript renderer is needed for this initial preview.

Keep result and retrospective separate, with the main result immutable once
retrospective starts. Human takeover, submit, continue, exclusive persistent
worker use, sibling parallelism, and tool inheritance must behave identically.
Cancellation must stop/cancel owned work, not just abandon the parent's wait.

## Emacs adapter

Use short, fixed `emacsclient` operations to invoke the companion Elisp package
for creation, prompt submission, reading, state, and closing. Encode arguments
as data; do not construct arbitrary Elisp from raw task text.

These calls must not wait inside Emacs for a task to finish. Long waits and
progress polling remain in the common asynchronous TypeScript runner. This
removes the need for the initially proposed Emacs orchestration socket/server.
If an operation needs asynchronous startup, return a handle immediately and
make readiness explicit; do not block the Emacs command loop for a worker.

Make narrow Pilish API changes where needed rather than copy its session setup
or wrap its private functions with advice. Use a non-displaying named-session
entry point with per-process arguments/environment and explicit process access.
Buffer creation must not steal focus; window layout remains the user's choice.

### Required input/completion correction

Installed Pilish queues busy input locally, then uses a 50 ms timer after
`agent_end` to drain it. A worker can finish before seeing a human intervention.

Submit ordinary busy human input through RPC `prompt` with
`streamingBehavior: "followUp"` or `"steer"`. That invokes Pi's `input` hook
at submission time, allowing the common child extension to take supervision.
The dedicated RPC `steer` and `follow_up` commands bypass that hook in Pi
0.85.1; substituting those alone does not fix takeover.

Use backend queue state, `clear_queue`, and `agent_settled` instead of the
local queue/settlement timer. When compaction rejects ordinary prompts, retain
the draft rather than pretending to accept work. Extension commands such as
worker continue/submit must dispatch immediately even while the worker is busy.
Merely editing an unsent draft is not supervision.

Terminal prompt submission must likewise preserve human drafts: typed text
must not silently append to an existing draft or be interpreted as key names.
This behavior belongs in the host's prompt-submission contract, not in a
shared parser for Pi's screen layout. Validate it explicitly in the tmux spike;
if terminal injection cannot satisfy it, change the common worker request
submission mechanism rather than reintroduce screen scraping.

### UI and terminal scope

`ask` currently uses TUI-only `ctx.ui.custom`; `/tools` explicitly rejects RPC.
Those interfaces need Emacs-native presentation or supported standard RPC
dialogs. Keep their policy/data shared and their presentation separate from
the host process API. Pilish also currently cancels unsupported multiline
`editor` requests; implement that standard RPC dialog where existing tools need it.

For shell panels, choose the required semantics before implementing the Emacs
side. Comint suffices for servers, builds, watchers, and line-oriented REPLs;
fullscreen/curses programs and arbitrary terminal keys require a real terminal
such as EAT. Both EAT and vterm are installed, but supporting multiple Emacs
terminal engines is not justified. Do not silently claim full terminal parity
for a comint implementation.

## Selection, scope, and cleanup

Select one host per Pi process, not per tool call. Pilish explicitly marks the
Emacs host and server endpoint in its child's environment. Other sessions can
use an explicit selection or an unambiguous native environment. Nested hosts
can expose both `TMUX` and `HERDR_*`; conflicting detection must not silently
choose. Children inherit the chosen host and endpoint.

Initially use a local host and shared local filesystem. This makes the current
worker artifacts applicable to all three hosts. Remote Pilish/TRAMP does not
automatically satisfy that contract; remote execution is a separate requirement.

Call tmux's machine-oriented CLI directly from its adapter. Do not wrap the
1,541-line `bin/pi-tmux` script as the new backend: it combines pane operations
with semaphore orchestration, old-format output parsing, prompt detection,
Claude-specific bridging, and global cleanup side effects.

After migration approval, replace the duplicated packages and update the
active settings, root tool-control metadata, lints, fork imports, and docs.
Keep three native adapters, not three extension packages or old-name aliases.
Intentional legacy features outside the selected common tool set are a scope
decision, not something to silently resurrect or remove during extraction.

## Implementation order

1. Extract the current shared worker semantics and narrow host contract from
   Herdr; prove Herdr still behaves the same.
2. Implement tmux directly against that contract. Test native identity,
   startup, prompt/draft handling, capture, and process death. Delete obsolete
   protocol parsing rather than bringing it into the common layer.
3. Implement Emacs/Pilish operations and fix human-input ordering.
4. Exercise the same delegate/persistent-worker lifecycle tests on all hosts:
   retries, compaction, takeover, retrospective failure, duplicate names,
   cancellation, missing processes, and mismatched/late results. Test
   `/fork-here` both idle and with an initial prompt, unchanged parent drafts,
   explicit parent placement, nested forks, and fork-discussion while `ask`
   remains open.
5. Switch package loading once and remove duplicate implementations after approval.

Use fake Pi/provider fixtures for lifecycle tests, then a small real interactive
smoke test on each host. Do not use paid model calls for retry/failure tests.

## Local investigation facts

- Pilish 3.0.1, commit `043dd368f0f58de8a183398bbd24468361a657d5`, installed at
  `/home/claude/.local/share/pilish`; matched upstream `master` when inspected.
- Emacs 30.2 server: `/home/claude/.emacs.d/server/pilish`. Bare `emacsclient`
  selected another user's inaccessible runtime socket; the explicit path works.
- Two disposable named Pilish sessions in `/tmp/` returned distinct Pi process
  and session IDs through successful `get_state` calls. Closed afterward;
  original session left running. No model prompt was submitted.
- Pi CLI and reference checkout now both report 0.85.1. The reference was
  fast-forwarded from 0.85.0 per the workspace version-match requirement.
- No unified adapter, worker lifecycle, or shell implementation has been tested
  yet. Existing uncommitted source changes were left untouched.

Main references: both packages' `coding-agent.ts` and `worker-frame.ts`, Herdr's
`delegate-runner.ts` and `herdr-helpers.ts`, tmux's `tmux.ts` and `bin/pi-tmux`,
Pilish's `pilish.el`, `pilish-core.el`, `pilish-input.el`, relevant queue/event
handlers in `pilish-render.el`, and Pi 0.85.1 `docs/rpc.md` plus `AgentSession`.
