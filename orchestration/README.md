# Pi orchestration

One worker implementation with native tmux, Herdr, and Emacs/Pilish hosts, plus
a browser host backed by a tau web server.
Load this package and the parent `pi-ant` package directly from local paths in
Pi's settings. No extension-local npm installation is needed.

## Hosts

- **tmux:** direct machine-oriented CLI; Pi TUI in owned panes.
- **Herdr:** tested with 0.8.2; named Pi agents in owned panes.
- **Emacs:** local Pilish with the named-session API in this workspace's
  `/home/devops/Projects/pi/pilish` checkout. The required generic APIs are
  published on [offline-ant/pilish's pi-orchestration branch](https://github.com/offline-ant/pilish/tree/pi-orchestration)
  (verified revision `3987521`, on v3.1.0); stock Pilish does not include them.
  EAT 0.9.4 is the sole shell terminal. Pi uses RPC chat/input pairs; shell panels support terminal keys
  and fullscreen applications. Load Pilish and EAT on the server's load path.
  Load `emacs/pi-orchestration.el` in Pilish's `use-package :config`, before
  the first root Pi spawn (not just when a worker starts):

  ```elisp
  (use-package pilish
    :commands (pilish pilish-toggle pilish-session-browser)
    :config
    (add-to-list 'load-path "/path/to/pi-ant/orchestration/emacs")
    (require 'pi-orchestration))
  ```

  The adapter also loads the companion when handling native operations.
- **Web:** a [tau](https://github.com/milanglacier/pi-tau-web-server) server (this
  workspace's `../../tau` fork) owning `pi --mode rpc` children, each one a live
  browser tab. Prompts are RPC commands, so submission is draft-safe without a
  terminal control socket, and `read` returns the transcript tail rather than a
  pane snapshot. The host has no terminal: shell panels stay on a terminal host,
  and typed text or key presses are refused. A finished worker's tab disappears
  from the server with its child; its session file remains in Pi's session list.

Select one host per Pi process with `PI_ORCHESTRATION_HOST=tmux|herdr|emacs|web`
and `PI_ORCHESTRATION_ENDPOINT` (tmux/Herdr socket, Emacs server endpoint, or the
tau server URL, whose userinfo carries its HTTP Basic credentials).
Without explicit selection, an unambiguous tmux or Herdr environment is used.
Conflicting native environments fail rather than guessing.
`PI_ORCHESTRATION_ENDPOINT` belongs to the explicitly selected host only; other
reachable hosts use their native endpoint (`HERDR_SOCKET_PATH`, `TMUX`).

A running tau server publishes its endpoint in `~/.pi/agent/tau/server.json`, so
the web host is reachable from any Pi process on the machine. It never wins
automatic selection away from a terminal: a session in tmux, Herdr, or Emacs
keeps that host until someone selects `web`. Only a session with no terminal host
at all falls back to a published server.

`/orchestration-host [tmux|herdr|emacs|web|reset|status]` overrides that environment
default for the current session branch, with a picker when the argument is
omitted. Only hosts reachable from this process are offered, for example Herdr
when Pilish itself runs inside a Herdr pane. The override applies to new workers,
panels, and forks; existing targets keep their host. It survives reload/resume
and normal forks, and `reset` returns to the environment default. The footer
shows `host:<kind>` (`*` for an override) when there is a choice. The companion uses
Pilish's generic `pilish-session-environment-functions` hook to set the Emacs
host, live server endpoint, and root session target before spawn. Owned children
retain their explicit target identity and endpoint across reload.
Targets retain their host and endpoint; later environment changes cannot redirect
operations. Execution and session/artifact files must be local; TRAMP is unsupported.

Child startup preserves the parent agent directory override, provider, model,
thinking level, and nesting depth unless a `do`, `delegate`, or `fresh_look` call
explicitly selects the configured alternate model (see below). Root depth is
zero; children at depths one through three are allowed. A depth-three session remains usable but cannot start
another Pi child. Shell panels do not consume worker nesting depth.

## Tools

- `do({task})`: the preferred worker tool. The ephemeral worker continues from
  the conversation as it stood before the calling assistant message, in the
  current directory, so `task` is a brief goal.
- `delegate({task, folder?})`: the occasional exception for a large standalone
  assignment. The worker starts blank with normal project/global resources;
  `task` must contain every necessary requirement.
- `fresh_look({task, folder?})`: like `delegate`, but also without discovered
  context files, skills, templates, or system prompts. It is disabled at
  startup; enable it manually in `/tools`.

  Saved tool selections remain exact; enable `do` in `/tools` if an existing
  selection does not include it.

  All three share one implementation and return the worker's result plus an
  automatic retrospective. Optional `alt` appears on all three only when enabled
  with `/delegate-alt`; omitted/false retains the caller's model, true uses the
  other configured model.
- `panel-start({name, command, folder?})`: start a server, watcher, or
  interactive program. There is no readiness wait: probe the service from `bash`
  or read the panel. Panels need a terminal host; the web host refuses them.
- `panel-read({name, lines?})`: bounded snapshot, default 500 lines, maximum
  2,000 lines/50KB. Reads may overlap; no incremental/lossless-log promise.
- `panel-send({name, text?, keys?})`: exactly one of a literal line of text or
  terminal keys such as `ctrl+c` and `Escape`; text always presses Enter. The
  result is the panel's output shortly after the input. This is terminal input,
  not draft-safe Pi prompt delivery. Pilish Pi targets are RPC conversations,
  not terminals; supervise them in their input buffers. Web targets are RPC
  sessions with no terminal at all; supervise them in the browser tab.
- `panel-close({name})`: stop the owned target and release its name. Cancel an
  active worker request rather than closing it through this tool.

All four panel tools show every supplied argument in their normal collapsed TUI
call row, including partial arguments while the model is still streaming them.
Ordinary foreground `bash` remains Pi's built-in tool. Hosts close their own
half-created targets, so a failed or cancelled start leaves nothing registered.
All logical names share one registry and must match `^[a-z][a-z0-9_-]{0,31}$`.
Registered names, including exited panels and forks, remain reserved until
explicit close; a panel whose native surface was destroyed elsewhere reports
that on read and releases its name to the next `panel-start`. Native IDs are
diagnostic details, not public lookup names.

Independent sibling `do`/`delegate`/`fresh_look` calls run concurrently and
join before the parent continues. Pi startup alone is serialized to avoid
authentication races.

## Alternate-model delegation

Disabled by default: no configuration file is required or created, and `do`,
`delegate`, and `fresh_look` contain neither an `alt` parameter nor
alternate-model guidance.

Use `/delegate-alt` in TUI or RPC for **Disabled** or **Choose model pair**, then
select two distinct authenticated models. You can also use exact identifiers:

```text
/delegate-alt openai-codex/gpt-6-astra claude-agent/claude-fable-5-1
/delegate-alt status
/delegate-alt off
```

Choosing immediately re-registers `do`, `delegate`, and `fresh_look` with or
without optional boolean `alt` (default false), updating the actual schemas and
descriptions without a reload. The active-tool selection is preserved, including
disabled tools. This does not affect forks.

When enabled, `alt: true` selects the other member relative to the current
caller's provider/model; nested workers follow the same rule. Missing auth,
an unavailable model, a caller outside the pair, or a stale alternate request
after disabling produces an error, never a same-model fallback. Model IDs starting
with their own provider prefix are refused because Pi's child CLI interprets them
ambiguously. Parent model/thinking remain unchanged. The worker inherits thinking
clamped to the selected model's capabilities; startup flags and the structured
request use that same selection. Progress and results identify the selected model.
Once started, a request is not redirected by later configuration changes.

Selection is global to Pi's agent directory, saved atomically as private
`delegate-alt.json` (honoring `PI_CODING_AGENT_DIR`):

```json
{
  "models": ["openai-codex/gpt-6-astra", "claude-agent/claude-fable-5-1"]
}
```

`off` removes that optional file. Reload/resume, new sessions, and workers read
the same global setting; this is not branch-local state. Other running sessions
refresh before their next submitted prompt or worker-tool invocation, without file
watchers. Invalid configuration reports an error and hides the option while
ordinary same-model calls remain usable. Picker cancellation preserves the
previous selection. `/scoped-models` does not enable or disable this feature.

Model selection is independent of the tool. `do` with `alt: true` is the ordinary
second opinion and still carries the conversation; the Claude Agent provider may
represent unmatched inherited history as a lossy text handoff rather than native
tool/thinking history. For a review without the conversation, use `delegate`
with a complete brief, or `fresh_look` when project guidance is also unwanted.

## Interactive commands

`/fork-here [name] [folder] [-- <prompt>]` opens an independent conversation on
the same host, defaulting to the parent's cwd and the next available `fork-N`.
No prompt means idle. The parent branch, session, and editor draft are unchanged.
Forks inherit the active branch, provider/model/thinking, and exact applicable
active tools. They have no result wait, retrospective, or automatic close.
Tmux/Herdr use an explicitly identified sibling pane; Emacs creates a separate
non-displaying Pilish chat/input pair. Native placement never follows current
focus. Pi's built-in `/fork` is unchanged.

`Ctrl+Alt+F` opens an idle fork in Pi TUI and Pilish. The companion binds
`C-M-f` in both Pilish buffers to `pi-orchestration-fork-here`; Pilish itself
contains no orchestration environment, server dependency, or fork shortcut.
`ask` offers **Fork (discuss separately)** on all hosts: edit the discussion
prompt, fork immediately before
the active ask call, then return to the unchanged question and selections. This
works while the parent waits for the answer. `/tools` works in TUI and RPC using
shared selection policy with native presentation. Pilish's multiline
editor dialogs use separate buffers, never the parent prompt draft.

- `/panels`: list registered shell panels, workers, and interactive forks.
- `/worker-submit [text]`: submit the latest supervised reply or explicit text.
  A main-result submission starts the automatic retrospective; a retrospective
  submission completes the request without replacing the main result.
- `/worker-continue <prompt>`: send guidance immediately and restore automatic
  capture in the current phase.
- `/finish-worker-now <text>`: abort and settle active work, then finish without
  automatic retrospective. A main result already saved remains immutable.

## Completion and supervision

The shared `worker-frame.ts` owns one current request/result schema. The parent
writes `request.json`; `/worker-run` reads it and applies model/tool policy. The
child saves `result.md`, runs a retrospective (its prompt forbids tool calls; the
tool set is unchanged, so no transcript system message is added), saves `retrospective.md`,
and atomically publishes a matching `result.json`. Only that matching final
artifact means completion—not an input acknowledgement, idle screen, spinner,
or process exit. Failure resolution waits for Pi's `agent_settled`, including
retries and overflow compaction. A retry-exhausted or aborted main run enters
human supervision. A failed retrospective returns the successful main result
with an unavailable-retrospective note.

When `self_compact` is enabled, its private `pi-ant:self-compact-handoff` events
identify the terminating tool call and its resumed or failed handoff. Only a
matching successful tool result preserves automatic capture while native compaction
runs and the note restarts work. The eventual final answer follows the normal
result/retrospective path. Failed, cancelled, or skipped handoffs use the existing
failure handling even when they happen after `agent_settled`. No timers, polling,
or Pi-core changes are needed; human supervision is never overridden. Worker
prompts discourage compaction near completion only when the tool is enabled.

Ordinary submitted human input takes supervision before it is queued. Merely
editing a draft does not. Pilish submits ordinary input through RPC `prompt` with
`streamingBehavior`; every RPC submission runs extension `input` handlers, so
supervision is taken however the human sends it. Backend queue snapshots,
`clear_queue`, and `agent_settled` replace local follow-up queues/timers. Rejected
ordinary prompts, including compaction rejection, keep the input draft.

Both tmux paste and Herdr 0.8.2 `agent prompt` append to human drafts. Therefore
both terminal adapters explicitly load the same internal `terminal-input`
extension and submit machine prompts over a private local Unix socket. It calls
Pi's supported extension input API without reading or modifying the editor.
This is only input delivery, not another worker protocol or scheduler.
`fresh_look` terminal workers load this input extension and the common worker
frame explicitly; on Emacs they need only the common frame. `fresh_look` blanks
the worker's conversation and instructions, not its runtime: extension discovery stays enabled, because
providers are registered by extensions and a worker cannot reach an
extension-registered model without them.

The parent polls structured status and bounded native output through the same
`onUpdate` contract on every host. The complete transcript remains in the child
pane/buffer and session file. Every worker closes itself after writing its
final result. Cancellation stops owned work instead of abandoning the wait. Session files and diagnostics remain
available for recovery. Workers receive available parent tools plus `do`. First-action re-delegation
gets a one-time warning. Above 90% parent context (using Pi's reported model
limit), the first `do` on a branch is not started and suggests `delegate`;
explicitly retrying `do` proceeds. `delegate` and `fresh_look` never warn.

## Files and recovery

Every `do`, `delegate`, and `fresh_look` publishes a copyable resume command as
soon as its session is prepared, before host startup or output capture. The hint
leads every progress update and final result/error, so the normal collapsed TUI
preview shows it even after parent Escape or a provider/budget/token failure.
Progress and successful results also include `details.sessionCommand`; thrown
errors keep the command in model-visible text because Pi discards error details.
Finished tool results persist in the parent transcript, including cancellation.
Live progress alone is not durable if the parent process is forcibly killed.

Run the offered command **after the original worker has stopped**. If cleanup
failed, resolve that failure first to avoid two processes writing one session.
It uses shell-quoted `pi --session <file>`, clears inherited nesting/private input
socket/target identity, and retains an explicit agent-directory override as an
absolute path. Pi restores the saved working directory and model/thinking state;
no `cd`, original worker flags, temporary request files, or `/worker-run` are needed.
The worker request is process-local, so reopening does not resurrect automatic
completion, retrospective, or auto-close. Normal resources load, including for a
former `fresh_look`. Enter a new prompt to continue; `/login`, `/model`, or
`/compact` may be needed to resolve the original failure. This is an independent
ordinary session, not a resumed parent tool call. No session files are deleted
or rewritten by orchestration cleanup; only already-persisted progress is recoverable.

- `/tmp/pi-orchestration-worker-*`: request, status, main result, retrospective,
  final matching result, and prompt diagnostics.
- `/tmp/pi-orchestration-targets`: target records and exclusive request claims.
- `/tmp/pi-terminal-*`: private terminal-input sockets, removed with owned targets.
- `/tmp/pi-panel-*`: Herdr shell command liveness files, removed on close.

Abruptly killed parent processes can leave claim files. Their contents identify
the owning PID; verify that process is gone before manually removing its exact
claim. There is no global stale-cleanup command. Old state is not migrated or
read; legacy tmux semaphore/Claude bridge tools and backend-specific package
aliases have been removed. Existing running sessions are not restarted at cutover.

## Checks

From `pi-ant/`:

```sh
npm run check
node scripts/test.mjs extensions/self-compact.test.ts orchestration/worker-frame.test.ts orchestration/workers.test.ts
node scripts/test.mjs orchestration/delegate-alt.test.ts orchestration/extensions/delegate.test.ts orchestration/context.test.ts orchestration/worker-call.test.ts orchestration/worker-resume.test.ts
PI_NATIVE_HOST_SMOKE=1 node scripts/test.mjs orchestration/hosts/native-smoke.test.ts
PI_LIFECYCLE_SMOKE=1 node scripts/test.mjs orchestration/hosts/lifecycle-smoke.test.ts
PI_FORK_SMOKE=1 node scripts/test.mjs orchestration/hosts/fork-smoke.test.ts
```

The last two use the installed real Pi with its in-process faux provider and
owned tmux/Herdr/Emacs targets. They exercise result/retrospective separation,
self-closing workers, per-request model/tool selection, draft protection, supervision/recovery, retry and
overflow compaction settlement, and public idle/prompted forks. Unit tests cover
claims, cancellation cleanup, mismatched results, context preparation, sibling
startup ordering, and TUI/RPC ask selection preservation. No paid provider calls
are needed. Native tests require local tmux, Herdr, Emacs, Pilish, and EAT.
