# pi-ant

`pi-ant` is Ant's local pi extension package. It replaces the individual local extension packages that were previously listed in `~/.pi/agent/settings.json`.

## Contents

- Semaphore lock coordination (`semaphore_wait`, `/lock`, `/release`, `/wait`, `/lock-list`) backed by `bin/pi-semaphore`.
- Tmux workflow tools (`tmux-bash`, `tmux-capture`, `tmux-send`, `tmux-kill`, `tmux-coding-agent`, `minitask`) and tmux commands (`/clear-stale`, `/tmux-list`, `/supervise`) backed by `bin/pi-tmux`.
- Complete context injection commands (`/read-complete`, `/bash-complete`).
- Personal lint and safety extensions (`lints`, `exec-lints`, `/principles`).
- Working status text tweak that removes the spinner from `Working...`.
- Interactive clarification tool (`ask`).
- Reflection memory checkpoint command (`/reflect`).
- Working-directory switch command (`/cwd <path>`) that keeps the current session file open.
- Git worktree creation command (`/worktree <name>`) that switches pi into the new worktree session.

## Local settings

Load this package as a single pi package from `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    "../../../devops/Projects/pi/pi-ant"
  ]
}
```

