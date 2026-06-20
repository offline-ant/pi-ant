# pi-ant

Personal set of tiny pi extensions for orchestration and misc development tools.

## Agent tools

These are the pi tools registered by this package:

- `ask` — ask the user interactive multiple-choice or free-form questions.
- `browser` — control persistent Chromium/Firefox sessions through `bin/browser-io`, including navigation, awaited JavaScript eval, and before/after screenshots under `/tmp/browser-io`.
- `call` — run a delegated task in a forked tmux pi worker; the worker must finish with `return`, and the compact return text becomes the `call` tool result.
- `return` — return exact result text from an active tmux-backed `call` frame.
- `minitask` — run an isolated one-shot pi RPC task without this session's context.
- `semaphore_wait` — block until one or more semaphore locks release, backed by `bin/pi-semaphore`.
- `sqlite` — run `sqlite3` against `AGENTS.db` in the current working directory; auto-enabled when that database exists.
- `tmux-bash`, `tmux-capture`, `tmux-send`, `tmux-kill`, `tmux-coding-agent`, `tmux-fork` — tmux pane, child-agent, and session-fork workflow tools backed by `bin/pi-tmux`.
- Core `edit` and `write` are wrapped by `lints` to display post-write safety warnings.
- Nested pi guard: `PI_NESTED` is initialized/incremented by the extension runtime; pi exits before work when nesting reaches 4.
- `present_guidance` — validates structured guidance output for guidance-mode final answers. It is only registered for `PI_GUIDANCE=true` runs or dynamically inside `/ugo` guide-phase sessions.

## Commands, snippets, and safety extensions

- Semaphore lock commands: `/lock`, `/release`, `/wait`, `/lock-list`.
- Call-frame commands: `/bobs-mode [on|off|status|toggle]` toggles Bob's mode and can restrict the root tool set to `call`; `/return-now "message"` is a child-frame recovery command that returns `message` and shuts down the worker. See `HOWTO-CALL-MODE.md`.
- Tmux workflow commands: `/clear-stale`, `/tmux-list`, `/prompt-mini`, `/abort-mini`, `/expand-minitask`, `/tmux-fork`.
- Tool worker model commands: `/set-tool-model` saves the current model as the favorite tool-worker override and enables it; `/tool-model` toggles that favorite override on/off for `call`, `minitask`, and spawned pi workers when no explicit `piArgs` are supplied.
- Complete context injection commands: `/read-complete`, `/bash-complete`.
- SQLite workflow commands: `/sqlite-init`, `/agent-db`.
- Context explorer commands: `/context-explorer`, `/context-explorer-stop`.
- Prompt history command: `/prompt-history`.
- Vim conversation edit command: `/vim` — opens the current conversation transcript in `$VISUAL`/`$EDITOR`/`vim`; changed lines are sent as the next user message.
- Reflection memory checkpoint command: `/reflect`.
- Working-directory switch command: `/cwd <path>`.
- Git worktree creation command: `/worktree <name>`.
- Execution safety toggle: `/exec-lints`.
- Workboard command/context: `/new-workboard` creates `workboard.md`; when `workboard.md` exists in the current working directory, it is autoloaded into agent context as active operational state. Cold ideas/backlog items belong in project files outside `workboard.md` until promoted to `needs-enrichment` or `ready`.
- AGENTS.d auto-loading: when a `./AGENTS.d/` directory exists in the workspace, its top-level files and file-target symlinks are automatically loaded and injected into the system prompt before every agent start. Subdirectories are listed in a tree structure (at the end of the injected block) but their contents are not loaded. Symlinks show their resolved real path. Dangling symlinks appear in the tree listing but are excluded from content loading.
- Guidance mode: `PI_GUIDANCE=true pi -p "inspect workboard.md and present_guidance"` injects guidance instructions and requires a structured `present_guidance` result. `bin/pi-guidance-loop` repeatedly runs guidance, executes `CONTINUE_WORK` prompts, applies `UPDATE_WORK` workboard updates, and stops on `REQUIRE_HUMAN_DECISION` or `EMPTY_WORKBOARD`.
- Ugo workboard loop: `/ugo [auto|manual] [max=N]` alternates ugo-guide and ugo-do phases in fresh sessions. Default `manual` mode creates the ugo-do session and pre-fills the ugo-do prompt; `auto` runs continuously until `REQUIRE_HUMAN_DECISION`/`EMPTY_WORKBOARD`/`max`. Ugo requires a clean git worktree and commits changed files after each ugo-guide/ugo-do phase with the prompt and result in the commit message. Human-decision phases watch `workboard.md` and `scratch/decisions/*` for `DONE:` or `CLARIFY:` signals, apply the resulting workboard transition, and continue. Empty-workboard phases remain active and watch `workboard.md` for new work without creating decision artifacts. `/ugo-continue` continues manual, human-decision, or empty-workboard mode; `/ugo-disable` disables loop control without aborting the current agent turn; and `/ugo-status` reports state. See `HOWTO-UGO.md`.
- `#` prompt snippets: `#principles`, `#cut`, `#mini-review`, `#call-progress`, `#supervise`, `#api-review`, `#enrich`, `#distill`.
