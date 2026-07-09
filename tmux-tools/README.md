# tmux-tools

Tmux-backed orchestration tools for pi. This package lives as a plain subproject inside the `pi-ant` repo and is loaded separately from `~/.pi/agent/settings.json`.

## Requirements

- pi must run inside a tmux session for tmux-backed tools (`TMUX` env var set).
- `tmux` must be installed.
- The package should be loaded before `pi-ant` so worker/orchestration tools are available to the personal extensions.

## Tools

- `tmux-bash` — create a new tmux pane with a lock name and run a long-lived command.
- `tmux-capture` — capture output from a tmux pane by lock name or pane id; default mode returns new output since the last capture.
- `tmux-send` — send text or keys to a pane by lock name or pane id.
- `tmux-kill` — kill a pane by lock name or pane id.
- `tmux-fork` — fork the current pi session into a new interactive pi agent pane.
- `semaphore_wait` — wait for semaphore locks and show periodic tmux output peeks while waiting.
- `call` — run a delegated current-context task in a forked tmux pi worker and return the result.
- `coding-agent` — run a task in a named persistent fresh-context tmux worker.
- `minitask` — run one isolated fresh-context task in an ephemeral tmux worker.

## Commands

- `/lock`, `/release`, `/wait`, `/lock-list` — semaphore lock commands.
- `/clear-stale`, `/tmux-list`, `/tmux-fork` — tmux workflow commands.
- `/bobs-mode [on|off|status|toggle]` — restrict root tools to orchestration tools.
- `/finish-call-now "message"` — child-frame recovery command for active worker requests.
- `/set-tool-model`, `/tool-model` — configure model overrides for tmux-spawned pi workers.

## Binaries

- `bin/pi-tmux` — tmux pane/session helper used by the extensions.
- `bin/pi-semaphore` — lock helper used by `semaphore_wait` and tmux workers.
- `bin/clear-stale` — standalone stale tmux/semaphore cleanup helper.
- `bin/pi-claude-agent` — Claude agent bridge used by `pi-tmux claude-agent`.

## Worker state

Runtime files are written under `/tmp`:

- `/tmp/pi-semaphores` — semaphore lock files.
- `/tmp/pi-tmux-state` — pane/agent marker files.
- `/tmp/pi-tmux-streams` — watch streams.
- `/tmp/pi-tmux-worker-*` — structured worker artifacts.
- `/tmp/pi-tmux-coding-agents` — persistent coding-agent registry.

See `HOWTO-CALL-MODE.md` for `call`, `coding-agent`, `minitask`, and Bob's mode behavior.
