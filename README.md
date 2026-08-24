# pi-ant

Personal set of tiny pi extensions for misc development tools. Orchestration
lives in sibling subprojects loaded as separate pi packages: `tmux-tools/` for
legacy tmux-backed workflows and `herdr-tools/` for Herdr-backed workflows.
Herdr exposes interactive session forking as the user command `/herdr-fork`;
structured worker orchestration remains LLM-callable tools.

## Agent tools

These are the pi tools registered by this package:

- `ask` — ask the user interactive multiple-choice or free-form questions.
- `browser` — control persistent Chromium/Firefox sessions through `bin/browser-io`, including navigation, awaited JavaScript eval, and before/after screenshots under `/tmp/browser-io`.
- `fresh_pov_review` — run an isolated sequential document review with per-unit source text and friction progress. It is inactive by default and can be exposed through `/tools`.
- `send_mail` — review, confirm, and send plain-text mail through an externally configured implicit-TLS SMTP account. Sender and recipients cannot be selected by the model.
- `sqlite` — run `sqlite3` against `AGENTS.db` in the current working directory; auto-enabled when that database exists.
- Core `edit` and `write` are wrapped by `lints` to display post-write safety warnings.
- `present_guidance` — validates structured guidance output for guidance-mode final answers. It is only registered for `PI_GUIDANCE=true` runs or dynamically inside `/ugo` guide-phase sessions.

## Mail configuration

`send_mail` reads `mail.json` from Pi's global agent directory (normally
`~/.pi/agent/mail.json`) on each invocation. Set `PI_MAIL_CONFIG` to an absolute
path to use another file. The file must be owned by the current user and have
mode `0600` on POSIX systems:

```json
{
  "host": "mail.roelof.solar",
  "port": 465,
  "username": "pi-sender@roelof.solar",
  "password": "replace-with-the-dedicated-account-password",
  "from": "pi-sender@roelof.solar",
  "to": ["self.pi@roelof.solar"]
}
```

The connection always uses implicit TLS with certificate verification and TLS
1.2 or newer. There is no plaintext or certificate-verification fallback. The
tool accepts only a subject and plain-text body, shows the complete body in the
editor, and requires explicit confirmation before connecting. It is unavailable
in modes without interactive confirmation.

For the current Mox deployment, `self.pi@roelof.solar` belongs to the
`postmaster` account, while `pi-sender@roelof.solar` belongs to a dedicated
`pi-mail` account. Configure them from the Mox container with:

```sh
mox config address add self.pi@roelof.solar postmaster
mox config account add pi-mail pi-sender@roelof.solar
mox setaccountpassword pi-mail
```

Do not reuse the postmaster password. The dedicated sender account limits a
leaked SMTP credential to that automation account rather than the postmaster
mailbox.

## Skills

- `herdr` — copied from Herdr's `SKILL.md`; teaches agents running inside Herdr to use the `herdr ...` CLI for pane, workspace, wait, and agent coordination.

## Commands, snippets, and safety extensions

- Complete context injection commands: `/read-complete`, `/bash-complete`.
- SQLite workflow commands: `/sqlite-init`, `/agent-db`.
- Context explorer commands: `/context-explorer`, `/context-explorer-stop`.
- Prompt history command: `/prompt-history`.
- Fresh-ingress review command: `/fresh-pov-review <document-path> [--profile <reader profile>]` runs a persistent isolated agent with no discovered context, skills, prompts, extensions, or built-in tools. The agent-callable `fresh_pov_review({ file, prompt? })` tool is inactive by default and can be enabled through `/tools`, so it consumes no model context until selected. Both entry points reveal Markdown in visually coherent 3–6-sentence reading units, show each consumed source unit with its recorded friction and current reader thinking/output, and save the full session, metadata, and final review under `scratch/fresh-pov/` in the active working directory. Slash-command results are inserted into the current agent context; tool results enter it normally as tool output.
- Vim conversation edit command: `/vim` — opens the current conversation transcript in `$VISUAL`/`$EDITOR`/`vim`; changed lines are sent as the next user message.
- Reflection memory checkpoint command: `/reflect`.
- Working-directory switch command: `/cwd <path>`.
- Git commit command: `/git-commit [message]` runs `git add -A && git commit -m <message>`, defaulting to `auto`.
- Git worktree creation command: `/worktree <name>`.
- Execution safety toggle: `/exec-lints`.
- Tool configuration: `/tools` opens a branch-persistent interactive selector. The Tools tab enables or disables individual ordinary tools immediately; Tab opens Profiles for the saved `Default`, `coding`, `research`, `orchestration`, `full`, and `bobs`. Ctrl+S saves the exact current ordinary tool selection to `~/.pi/agent/tool-selection.json` as the global default for new sessions. `research` is the built-in fallback until a default is saved. The deterministic `bobs` profile restricts the root to delegation tools, gives inherited `delegate` workers the Research tool profile, and injects root orchestration instructions. `delegate` requires `context: "inherit" | "project" | "clean"`; the modes respectively fork the current conversation, start a blank conversation with project/global resources, or start a blank conversation without discovered resources. An independent delegate-only sibling batch executes concurrently and joins before the parent continues. Structured workers and Ugo keep their own tool control; required dynamic tools such as `sqlite` and `present_guidance` remain active when applicable.
- Workboard command/context: `/new-workboard` creates `workboard.md`; when `workboard.md` exists in the current working directory, it is autoloaded into agent context as active operational state. `/new-workflow` creates editable `workflow.md` guidance policy; `/ugo` and guidance mode also create it when missing. Cold ideas/backlog items belong in project files outside `workboard.md` until promoted to `needs-enrichment` or `ready`.
- AGENTS.d auto-loading: when a `./AGENTS.d/` directory exists in the workspace, its top-level files and file-target symlinks are automatically loaded and injected into the system prompt before every agent start. Subdirectories are listed in a tree structure (at the end of the injected block) but their contents are not loaded. Symlinks show their resolved real path. Dangling symlinks appear in the tree listing but are excluded from content loading.
- Guidance mode: `PI_GUIDANCE=true pi -p "inspect workboard.md and present_guidance"` loads editable `workflow.md` guidance policy and requires a structured `present_guidance` result. `bin/pi-guidance-loop` repeatedly runs guidance, executes `CONTINUE_WORK` prompts, applies `UPDATE_WORK` workboard updates, and stops on `REQUIRE_HUMAN_DECISION` or `EMPTY_WORKBOARD`.
- Ugo workboard loop: `/ugo` alternates ugo-guide and ugo-do phases in fresh sessions until `REQUIRE_HUMAN_DECISION`, `EMPTY_WORKBOARD`, commit failure, Escape, or `/ugo-pause`. Ugo creates `workflow.md` when missing and loads it as editable guidance policy for guide phases. Ugo requires a clean git worktree except for `workboard.md`, `workflow.md`, and `scratch/`, and commits changed files after each ugo-guide/ugo-do phase with the prompt, result, and automatic no-tools ugo-do reflection in the commit message. The reflection has `Retrospective` and `Simplify` notes; the complete reflection is injected into the next ugo-guide prompt so guidance can promote relevant improvements into workboard updates/items. Human-decision phases watch `workboard.md` and `scratch/decisions/*` for `DONE:` or `CLARIFY:` signals, apply the resulting workboard transition, and continue. Empty-workboard phases remain active and watch `workboard.md` for new work without creating decision artifacts. `/ugo` also resumes paused, human-decision, or empty-workboard state; `/ugo-pause` stops watchers immediately or pauses after the active phase safely checkpoints. See `HOWTO-UGO.md`.
- `#` prompt snippets: `#principles`, `#cut`, `#simplify`, `#delegate-review`, `#ts`, `#delegate-progress`, `#supervise`, `#api-review`, `#enrich`, `#distill`.
