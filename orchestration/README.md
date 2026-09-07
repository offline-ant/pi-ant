# Pi orchestration

One worker implementation with native tmux, Herdr, and Emacs/Pilish hosts.
Load this package and the parent `pi-ant` package directly from local paths in
Pi's settings. No extension-local npm installation is needed.

## Hosts

- **tmux:** direct machine-oriented CLI; Pi TUI in owned panes.
- **Herdr:** tested with 0.8.2; named Pi agents in owned panes.
- **Emacs:** local Pilish with the named-session API in this workspace's
  `/home/claude/.local/share/pilish` checkout. The required generic APIs are
  published on [offline-ant/pilish's pi-orchestration branch](https://github.com/offline-ant/pilish/tree/pi-orchestration)
  (verified revision `9613b9e`); stock Pilish 3.0.1 does not include them.
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

Select one host per Pi process with `PI_ORCHESTRATION_HOST=tmux|herdr|emacs`
and `PI_ORCHESTRATION_ENDPOINT` (tmux/Herdr socket or Emacs server endpoint).
Without explicit selection, an unambiguous tmux or Herdr environment is used.
Conflicting native environments fail rather than guessing. The companion uses
Pilish's generic `pilish-session-environment-functions` hook to set the Emacs
host, live server endpoint, and root session target before spawn. Owned children
retain their explicit target identity and endpoint across reload.
Targets retain their host and endpoint; later environment changes cannot redirect
operations. Execution and session/artifact files must be local; TRAMP is unsupported.

Child startup preserves the parent agent directory override, provider, model,
thinking level, and nesting depth. Root depth is zero; children at depths one
through three are allowed. A depth-three session remains usable but cannot start
another Pi child. Shell panels do not consume worker nesting depth.

## Tools

- `delegate({task, context, folder?})`: ephemeral task plus retrospective.
  `context` is required: `inherit` forks before the calling assistant message;
  `project` starts blank with normal project/global resources; `clean` starts
  blank without discovered context, extensions, skills, templates, or system
  prompts. Inherited delegates cannot change cwd. Project/clean tasks must
  contain every necessary conversation-specific requirement.
- `coding-agent({name, task, folder?})`: persistent fresh-context worker;
  subsequent requests reuse its session and reapply the caller's model,
  thinking level, and tools. Each name has one active request at a time.
- `fresh-history({prompt, history})`: ephemeral worker seeded with recent
  user requests and direct assistant replies, excluding tool activity. Includes
  session-file/history-root references for recovery.
- `panel-start({name, command, folder?, waitFor?})`: terminal command;
  `waitFor: {match, regex?, timeoutMs?}` checks readiness, not completion.
- `panel-read({name, lines?})`: bounded snapshot, default 500 lines, maximum
  2,000 lines/50KB. Reads may overlap; no incremental/lossless-log promise.
- `panel-send({name, text?, keys?, enter?})`: exactly one of literal text or
  terminal keys such as `ctrl+c` and `Escape`. Text presses Enter by default.
  This is terminal input, not draft-safe Pi prompt delivery. Pilish Pi targets
  are RPC conversations, not terminals; supervise them in their input buffers.
- `panel-close({name})`: stop the owned target and release its name. Cancel an
  active worker request rather than closing it through this tool.

Ordinary foreground `bash` remains Pi's built-in tool. Readiness failures retain
the target and recent output for diagnosis; cancelling startup closes owned work.
All logical names share one registry and must match `^[a-z][a-z0-9_-]{0,31}$`.
Registered names, including exited panels and forks, remain reserved until
explicit close. Native IDs are diagnostic details, not public lookup names.

Independent sibling delegate/coding-agent calls run concurrently and join before
the parent continues. Different persistent names are required. Pi startup alone
is serialized to avoid authentication races. Batches containing `fresh-history`
remain sequential.

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
shared selection/profile policy with native presentation. Pilish's multiline
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
child saves `result.md`, runs a no-tools retrospective, saves `retrospective.md`,
and atomically publishes a matching `result.json`. Only that matching final
artifact means completion—not an input acknowledgement, idle screen, spinner,
or process exit. Failure resolution waits for Pi's `agent_settled`, including
retries and overflow compaction. A retry-exhausted or aborted main run enters
human supervision. A failed retrospective returns the successful main result
with an unavailable-retrospective note.

Ordinary submitted human input takes supervision before it is queued. Merely
editing a draft does not. Pilish uses RPC `prompt` with `streamingBehavior`, not
the input-hook-bypassing `steer`/`follow_up` RPC commands. Backend queue snapshots,
`clear_queue`, and `agent_settled` replace local follow-up queues/timers. Rejected
ordinary prompts, including compaction rejection, keep the input draft.

Both tmux paste and Herdr 0.8.2 `agent prompt` append to human drafts. Therefore
both terminal adapters explicitly load the same internal `terminal-input`
extension and submit machine prompts over a private local Unix socket. It calls
Pi's supported extension input API without reading or modifying the editor.
This is only input delivery, not another worker protocol or scheduler. Clean
terminal workers load this input extension and the common worker frame explicitly;
clean Emacs workers need only the common frame. Providers registered only by
other extensions are unavailable in clean mode.

The parent polls structured status and bounded native output through the same
`onUpdate` contract on every host. The complete transcript remains in the child
pane/buffer and session file. Cancellation stops owned work, including persistent
workers, instead of abandoning the wait. Session files and diagnostics remain
available for recovery. Workers receive available parent tools plus `delegate`;
the `bobs` profile supplies its delegated Research set. First-action re-delegation
gets a one-time warning. Above 50% parent context, the first inherited delegate
on a branch recommends project context; explicitly retrying inheritance proceeds.

## Files and recovery

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
node scripts/test.mjs orchestration/worker-frame.test.ts orchestration/workers.test.ts
PI_NATIVE_HOST_SMOKE=1 node scripts/test.mjs orchestration/hosts/native-smoke.test.ts
PI_LIFECYCLE_SMOKE=1 node scripts/test.mjs orchestration/hosts/lifecycle-smoke.test.ts
PI_FORK_SMOKE=1 node scripts/test.mjs orchestration/hosts/fork-smoke.test.ts
```

The last two use the installed real Pi with its in-process faux provider and
owned tmux/Herdr/Emacs targets. They exercise result/retrospective separation,
persistent model/tool changes, draft protection, supervision/recovery, retry and
overflow compaction settlement, and public idle/prompted forks. Unit tests cover
claims, cancellation cleanup, mismatched results, context preparation, sibling
startup ordering, and TUI/RPC ask selection preservation. No paid provider calls
are needed. Native tests require local tmux, Herdr, Emacs, Pilish, and EAT.
