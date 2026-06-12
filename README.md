# pi-ant

Personal set of tiny pi extention for orchestration and misc development tools.

## Contents

- Semaphore lock coordination (`semaphore_wait`, `/lock`, `/release`, `/wait`, `/lock-list`) backed by `bin/pi-semaphore`.
- Tmux workflow tools (`tmux-bash`, `tmux-capture`, `tmux-send`, `tmux-kill`, `tmux-coding-agent`, `tmux-fork`, `minitask`, `tempfork`) and tmux commands (`/clear-stale`, `/tmux-list`, `/prompt-mini`, `/abort-mini`, `/expand-minitask`, `/supervise`, `/minivise`, `/tmux-fork`) backed by `bin/pi-tmux`.
- Complete context injection commands (`/read-complete`, `/bash-complete`).
- Personal lint and safety extensions (`lints`, `exec-lints`, `/principles`, `#principles` autocomplete).
- Interactive clarification tool (`ask`).
- Reflection memory checkpoint command (`/reflect`).
- Working-directory switch command (`/cwd <path>`) that keeps the current session file open.
- Git worktree creation command (`/worktree <name>`) that switches pi into the new worktree session.
- Browser automation tool (`browser`) backed by `bin/browser-io` for persistent Chromium/Firefox sessions, URL navigation, awaited JS eval, and before/after screenshot paths under `/tmp/browser-io`.
