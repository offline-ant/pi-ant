# pi-ant

Personal set of tiny pi extensions for orchestration and misc development tools.

## Agent tools

These are the pi tools registered by this package:

- `ask` — ask the user interactive multiple-choice or free-form questions.
- `browser` — control persistent Chromium/Firefox sessions through `bin/browser-io`, including navigation, awaited JavaScript eval, and before/after screenshots under `/tmp/browser-io`.
- `call` — run a delegated task in a forked current-context tmux pi worker; the worker's final assistant message becomes the compact `call` tool result.
- `coding-agent` — run a task in a named persistent fresh-context tmux worker; waits for the task result and keeps the worker alive for follow-up work.
- `minitask` — run an isolated one-shot fresh-context tmux worker without this session's context.
- `semaphore_wait` — block until one or more semaphore locks release, backed by `bin/pi-semaphore`.
- `sqlite` — run `sqlite3` against `AGENTS.db` in the current working directory; auto-enabled when that database exists.
- `tmux-bash`, `tmux-capture`, `tmux-send`, `tmux-kill`, `tmux-fork` — low-level tmux pane and session-fork workflow tools backed by `bin/pi-tmux`.
- Core `edit` and `write` are wrapped by `lints` to display post-write safety warnings.
- Nested pi guard: `PI_NESTED` is initialized/incremented by the extension runtime; pi exits before work when nesting reaches 4.
- `present_guidance` — validates structured guidance output for guidance-mode final answers. It is only registered for `PI_GUIDANCE=true` runs or dynamically inside `/ugo` guide-phase sessions.

## Commands, snippets, and safety extensions

- Semaphore lock commands: `/lock`, `/release`, `/wait`, `/lock-list`.
- Worker commands: `/bobs-mode [on|off|status|toggle]` toggles Bob's mode and can restrict the root tool set to `call`, `coding-agent`, `ask`, and `minitask`; `/finish-call-now "message"` is a child-frame recovery command that overrides the active worker result with `message` and shuts down close-on-done workers. See `HOWTO-CALL-MODE.md`.
- Tmux workflow commands: `/clear-stale`, `/tmux-list`, `/tmux-fork`.
- Tool worker model commands: `/set-tool-model` saves the current model as the favorite tool-worker override and enables it; `/tool-model` toggles that favorite override on/off for `call`, `coding-agent`, `minitask`, and spawned pi workers.
- Complete context injection commands: `/read-complete`, `/bash-complete`.
- SQLite workflow commands: `/sqlite-init`, `/agent-db`.
- Context explorer commands: `/context-explorer`, `/context-explorer-stop`.
- Prompt history command: `/prompt-history`.
- Vim conversation edit command: `/vim` — opens the current conversation transcript in `$VISUAL`/`$EDITOR`/`vim`; changed lines are sent as the next user message.
- Reflection memory checkpoint command: `/reflect`.
- Working-directory switch command: `/cwd <path>`.
- Git commit command: `/git-commit [message]` runs `git add -A && git commit -m <message>`, defaulting to `auto`.
- Git worktree creation command: `/worktree <name>`.
- Execution safety toggle: `/exec-lints`.
- Workboard command/context: `/new-workboard` creates `workboard.md`; when `workboard.md` exists in the current working directory, it is autoloaded into agent context as active operational state. `/new-workflow` creates editable `workflow.md` guidance policy; `/ugo` and guidance mode also create it when missing. Cold ideas/backlog items belong in project files outside `workboard.md` until promoted to `needs-enrichment` or `ready`.
- AGENTS.d auto-loading: when a `./AGENTS.d/` directory exists in the workspace, its top-level files and file-target symlinks are automatically loaded and injected into the system prompt before every agent start. Subdirectories are listed in a tree structure (at the end of the injected block) but their contents are not loaded. Symlinks show their resolved real path. Dangling symlinks appear in the tree listing but are excluded from content loading.
- Guidance mode: `PI_GUIDANCE=true pi -p "inspect workboard.md and present_guidance"` loads editable `workflow.md` guidance policy and requires a structured `present_guidance` result. `bin/pi-guidance-loop` repeatedly runs guidance, executes `CONTINUE_WORK` prompts, applies `UPDATE_WORK` workboard updates, and stops on `REQUIRE_HUMAN_DECISION` or `EMPTY_WORKBOARD`.
- Ugo workboard loop: `/ugo [auto|manual] [max=N]` alternates ugo-guide and ugo-do phases in fresh sessions. Default `manual` mode creates the ugo-do session and pre-fills the ugo-do prompt; `auto` runs continuously until `REQUIRE_HUMAN_DECISION`/`EMPTY_WORKBOARD`/`max`. Ugo creates `workflow.md` when missing and loads it as editable guidance policy for guide phases. Ugo requires a clean git worktree except for `workboard.md`, `workflow.md`, and `scratch/`, and commits changed files after each ugo-guide/ugo-do phase with the prompt and result in the commit message. Human-decision phases watch `workboard.md` and `scratch/decisions/*` for `DONE:` or `CLARIFY:` signals, apply the resulting workboard transition, and continue. Empty-workboard phases remain active and watch `workboard.md` for new work without creating decision artifacts. `/ugo-continue` continues manual, human-decision, or empty-workboard mode; `/ugo-disable` disables loop control without aborting the current agent turn; and `/ugo-status` reports state. See `HOWTO-UGO.md`.
- `#` prompt snippets: `#principles`, `#cut`, `#mini-review`, `#ts`, `#call-progress`, `#supervise`, `#api-review`, `#enrich`, `#distill`.
