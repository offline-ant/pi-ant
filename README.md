# pi-ant

`pi-ant` is Ant's local pi extension package. It replaces the individual local extension packages that were previously listed in `~/.pi/agent/settings.json`.

## Contents

- Semaphore lock coordination (`semaphore_wait`, `/lock`, `/release`, `/wait`, `/lock-list`) backed by `bin/pi-semaphore`.
- Tmux workflow tools (`tmux-bash`, `tmux-capture`, `tmux-send`, `tmux-kill`, `tmux-coding-agent`, `minitask`, `smarteditor`) and tmux commands (`/clear-stale`, `/tmux-list`, `/supervise`, `/handoff`) backed by `bin/pi-tmux`.
- Complete context injection commands (`/read-complete`, `/bash-complete`).
- Conversation export command (`/save-conversation`).
- Personal lint and safety extensions (`lints`, `exec-lints`, `/principles`, `/tryout`).
- HPPR desktop notifications on prompt completion (`/hppr-notifications`) through `uprompt`.
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


## HPPR notifications

Enable prompt-finished desktop notifications with:

```text
/hppr-notifications on
```

Use `/hppr-notifications` for an interactive on/off toggle, or `/hppr-notifications status` for a short availability hint. The extension uses the existing `uprompt` command. Install/configure `uprompt` separately and run `uprompt listen` in the desktop session for visible popups. `uprompt status` reports listener and identity/config state.
