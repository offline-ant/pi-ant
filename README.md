# pi-ant

`pi-ant` is Ant's local pi extension package. It replaces the individual local extension packages that were previously listed in `~/.pi/agent/settings.json`.

## Contents

- Semaphore lock coordination (`semaphore_wait`, `/lock`, `/release`, `/wait`, `/lock-list`) backed by `bin/pi-semaphore`.
- Tmux workflow tools (`tmux-bash`, `tmux-capture`, `tmux-send`, `tmux-kill`, `tmux-coding-agent`, `minitask`) and tmux commands (`/clear-stale`, `/tmux-list`, `/supervise`, `/handoff`) backed by `bin/pi-tmux`.
- Complete context injection commands (`/read-complete`, `/bash-complete`).
- Conversation export command (`/save-conversation`).
- Personal lint and safety extensions (`lints`, `exec-lints`, `/principles`, `/tryout`).
- Interactive clarification tool (`ask`).
- Reflection memory checkpoint command (`/reflect`).

## Local settings

Load this package as a single pi package from `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    "../../../devops/Projects/pi/pi-ant"
  ]
}
```

The old `pi-semaphore`, `pi-tmux`, `pi-read-complete`, `pi-save-conversation`, `pi-sol`, `pi-ask`, and `pi-reflect` directories are left in the workspace for now as migration source/history, but active settings should not load them.

On macOS, sync the settings file with the path adjusted to the mac workspace layout, e.g. `/Users/claude/Projects/pi/pi-ant` if using absolute paths.
