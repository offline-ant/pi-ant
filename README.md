# pi-ant

Personal set of tiny pi extention for orchestration and misc development tools.

## Contents

- Semaphore lock coordination (`semaphore_wait`, `/lock`, `/release`, `/wait`, `/lock-list`) backed by `bin/pi-semaphore`.
- Tmux workflow tools (`tmux-bash`, `tmux-capture`, `tmux-send`, `tmux-kill`, `tmux-coding-agent`, `minitask`) and tmux commands (`/clear-stale`, `/tmux-list`, `/supervise`) backed by `bin/pi-tmux`.
- Complete context injection commands (`/read-complete`, `/bash-complete`).
- Personal lint and safety extensions (`lints`, `exec-lints`, `/principles`).
- Interactive clarification tool (`ask`).
- Reflection memory checkpoint command (`/reflect`).
- Working-directory switch command (`/cwd <path>`) that keeps the current session file open.
- Git worktree creation command (`/worktree <name>`) that switches pi into the new worktree session.
