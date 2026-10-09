# pi-ant

Personal Pi extensions for development tools. Unified orchestration lives in
[`orchestration/`](orchestration/README.md), loaded alongside this root package.
One worker protocol supports tmux, Herdr, and Emacs/Pilish with EAT terminals.
`/fork-here` opens independent interactive conversations; `do`, `delegate`,
`fresh_look`, neutral `panel-*` tools, and `wait` provide orchestration.
The replaced backend packages and legacy semaphore/Claude bridge tools are removed.
Emacs startup must load `orchestration/emacs/pi-orchestration.el` in Pilish's
`use-package :config` before the first Pi spawn. The companion owns host/server
identity and `C-M-f`; the separate Pilish checkout contains only generic session
APIs, RPC input/settlement, and editor dialogs. See the linked orchestration README.

## Agent tools

These are the pi tools registered by this package:

- `ask` — ask the user interactive multiple-choice or free-form questions. In TUI and RPC sessions, each question also offers `Fork (discuss separately)`: edit a discussion prompt, launch an inherited session on the selected host, then return to the unchanged question and answer it.
- `document_flow_review` — read one document strictly in sequence without lookahead and assess its internal coherence, including logical flow, definitions, transitions, expectations, internal contradictions, and misplaced or late information. It does not verify factual truth or external validity. The tool is inactive by default and can be exposed through `/tools`.
- Core `edit` and `write` are wrapped by `lints` to display post-write safety warnings.
- `self_compact` — the agent calls `self_compact({note})` alone in its tool batch at a clean checkpoint. Its normal TUI tool display shows the full handoff note as arguments stream in, without requiring expansion. The run ends, Pi's native compaction runs (normal summary prompt, model, and `keepRecentTokens` retention), and the note is then delivered verbatim as the next message, which continues the work without a human prompt. Structured workers retain automatic completion across this handoff; their eventual result and retrospective return normally. Human supervision is never overridden. It does not retry: failure, cancellation, or a skipped handoff is reported and work stops; an unfinished worker enters supervision (a saved main result is preserved if its retrospective fails). From 69% context usage, a generic reminder without usage numbers is added to each model request but not displayed or saved in the session. Tool guidance and reminders tell the agent to finish without `self_compact` when the original user request is nearly complete. The reminder also says to continue when all current context is needed, and to compact when much of it is irrelevant. Native `/compact` and automatic-compaction settings are unchanged. The tool is off unless enabled through `/tools`. Adapted from [disler/self-compact-pi-agent](https://github.com/disler/self-compact-pi-agent) (MIT). Focused test: `node scripts/test.mjs extensions/self-compact.test.ts`.
- `present_guidance` — validates structured guidance output for guidance-mode final answers. It is only registered for `PI_GUIDANCE=true` runs or dynamically inside `/ugo` guide-phase sessions.

Browser automation and web retrieval are provided by the separately loaded
[`pi-browser`](https://github.com/offline-ant/pi-browser) package, not this package. It registers
`browser`, `web_search`, `web_fetch`, and `web_read`, sharing its core and web-tool factories
with the standalone `pagent` application. `PI_WEB_BACKEND=auto` (default) prefers
Codex and reports browser fallback when unavailable; `codex` and `browser` select
strict backends. Backend selection is host configuration, not a tool argument.

## Herdr finish prompts

Inside a Herdr Pi TUI, while this Pi is idle:

```text
/start-tab-finish Review the changes and run the tests
/start-space-finish Check the combined work across this workspace
/start-finish-cancel
```

The first two commands wait, without model calls, until **all other recognized
agents** in the caller's tab or workspace are `idle` or `done`, then submit the
prompt once to this Pi. They do not create a tab, workspace, or session. Herdr
change events trigger fresh checks of the live scope: late arrivals and agents
that become busy again count; agents that leave no longer count. Ordinary shells
are ignored. `working`, `blocked`, and `unknown` prevent starting. No other agents
means the prompt can start immediately.

Waiting Pi sessions report `blocked` through the installed Herdr Pi integration
(`herdr:blocked`). Two waiters in each other's scope deliberately block each other;
cancel one to release the other. The integration must be active and its blocked
report must be observed before a prompt can start. The widget shows the pending
prompt and remaining agents. Only one prompt may be scheduled at a time.

Cancellation, another submitted prompt, this Pi starting work, branch/session
changes, reload, exit, connection failure, or the caller leaving its scope clear
the wait. Waits are not persisted or automatically retried. Submission uses Pi's
local message API and preserves human drafts. This is a live readiness check,
not an atomic scheduler or proof that the other agents succeeded. Commands are
absent outside Herdr and in RPC/print/JSON mode.

Focused checks from this directory:

```sh
node scripts/test.mjs extensions/herdr-finish.test.ts extensions/herdr-finish-client.test.ts
PI_HERDR_FINISH_NATIVE=1 node scripts/test.mjs extensions/herdr-finish-native.test.ts
```

The opt-in native test creates only disposable Herdr topology and real Pi TUIs
with faux inference; it never makes paid model calls or changes existing panes.

## Skills

The package exports `skills/`. After `/reload` or in a new session, invoke
`/skill:himalaya-mail` or ask the agent to use the skill. Other agents can read
[`skills/himalaya-mail/SKILL.md`](skills/himalaya-mail/SKILL.md) directly.

- `herdr` — local guidance for Herdr 0.9.0 CLI operations, with ownership safeguards and a separate managed Pi orchestration workflow.
- `himalaya-mail` — send, list, search, read without marking Seen, and reply through the ordinary Himalaya CLI using the separate `llm` mailbox with public From `llm@roelof.solar` and IMAP/SMTP login `llm-inbox@roelof.solar`. Mox's native public-address alias also delivers new incoming mail to postmaster; existing messages and outgoing Sent copies are not replicated. Himalaya 1.1.0 is configured locally with private files under `~/.config/himalaya/`; no credentials are included in this package. The skill covers authorization, MML attachment safety, and uncertain-send handling.

Verify package skill discovery without model calls:

```sh
node scripts/test.mjs scripts/skills.test.ts
```

## Commands, snippets, and safety extensions

- Document flow review command: `/document-flow-review <document-path> [--profile <reader profile>]` runs a persistent isolated agent with no discovered context, skills, prompts, extensions, or built-in tools. The agent-callable `document_flow_review({ file, prompt? })` tool is inactive by default and can be enabled through `/tools`, so it consumes no model context until selected. Both entry points reveal Markdown in visually coherent 3–6-sentence reading units and assess whether each unit follows coherently from what preceded it. They show each consumed source unit with its recorded friction and current reader thinking/output, then save the full session, metadata, and final review under `scratch/document-flow-review/` in the active working directory. This review concerns the document's internal consistency and sequence, not the factual truth or external validity of its claims. Slash-command results are inserted into the current agent context; tool results enter it normally as tool output.
- Vim conversation edit command: `/vim` — opens the current conversation transcript in `$VISUAL`/`$EDITOR`/`vim`; changed lines are sent as the next user message.
- Working-directory switch command: `/cwd <path>`.
- Git commit command: `/git-commit [message]` runs `git add -A && git commit -m <message>`, defaulting to `auto`.
- Git worktree creation command: `/worktree <name>`.
- Execution safety toggle: `/exec-lints`. Besides git and pipe-tail guards, it always blocks a local `sleep` of 2 seconds or more, or any `sleep` inside a shell loop, in `bash` and `panel-send` commands, pointing to the orchestration `wait` tool.
- Codemode delegation: `/codemode-delegate` toggles whether active `do`, `delegate`, and `fresh_look` tools are callable from scripts and other tools. Supports `on`, `off`, and `status`; saved globally, off (model-only) by default. Nested `do` inherits the conversation before the outer tool call, not script-local findings. See [orchestration](orchestration/README.md#codemode-delegation) for context and recovery limitations.
- Alternate delegate model: `/delegate-alt` chooses a globally saved model pair or disables alternate selection. Disabled by default, with no required configuration file. Choosing immediately adds/removes optional `alt` from the actual schemas and descriptions of `do`, `delegate`, and `fresh_look` without a reload; omitted/false retains the caller's model, true selects the other configured model (or the first if the caller is outside the pair). `/delegate-alt off` disables it; `/delegate-alt status` reports the selection. See [orchestration](orchestration/README.md#alternate-model-delegation).
- Tool configuration: `/tools` opens a branch-persistent toggle list in TUI or standard RPC dialogs that enables or disables individual tools immediately. Ctrl+S (RPC: **Save as default**) saves the exact current selection as `{"enabledTools": [...]}` in `~/.pi/agent/tool-selection.json`, the global default for branches without their own selection. Without a saved default, Pi's own active tool set is left unchanged. The selection is applied at session start, on branch changes, and on edits; before each prompt it is reapplied only if it changed (for example a default saved by another session, or Ugo control ending). Tools Pi activates itself in between stay active until the selection changes again: `codemode` or `tool_search` enabled when an MCP server connects, tools `tool_search` loads, and direct MCP tools. Selected tools that register later, such as those of a server that connected after startup, are activated. The list opens on the actual active tools, so toggling keeps Pi's activations. `do({task})` is the preferred worker tool: it continues from the current conversation in the current directory, so the task is a brief goal. `delegate({task, folder?})` is the occasional exception for a large standalone assignment; its worker sees project instructions but no conversation, so the task must be a complete brief. `fresh_look({task, folder?})` starts without conversation or discovered instructions; it is disabled at startup and is enabled manually in `/tools`. Independent sibling `do`, `delegate`, and `fresh_look` calls execute concurrently and join before the parent continues. Structured workers receive the caller's active tools that are available in the child, plus `do`. A worker that tries to start another worker as its first tool call receives a one-time warning before retries are allowed. Ugo keeps its own tool control; `present_guidance` remains required when registered.
- Workboard command/context: `/new-workboard` creates `workboard.md`; when `workboard.md` exists in the current working directory, it is autoloaded into agent context as active operational state. `/new-workflow` creates editable `workflow.md` guidance policy; `/ugo` and guidance mode also create it when missing. Cold ideas/backlog items belong in project files outside `workboard.md` until promoted to `needs-enrichment` or `ready`.
- AGENTS.d auto-loading: before every agent start, discovers `AGENTS.d/` in the current directory and every ancestor through the filesystem root, without stopping at repository boundaries. Like Pi's `AGENTS.md` ancestor traversal, content is concatenated outermost-first, with the current directory last; a local directory is not required and same-named files from different ancestors are all retained. Each directory's top-level files and file-target symlinks load alphabetically. File paths, tree roots, and notifications are relative to the current directory, distinguishing inherited sources. Subdirectories are listed in trees at the end of the injected block but their contents are not loaded. Symlinks show their resolved real path; dangling symlinks appear only in the tree listing. Discovery and contents refresh each run, including after cwd changes. This is ancestor inheritance only: no separate global config-directory lookup or Markdown-specific override/worktree-shadowing rules. Focused test: `node scripts/test.mjs extensions/agents-d.test.ts`.
- Guidance mode: `PI_GUIDANCE=true pi -p "inspect workboard.md and present_guidance"` loads editable `workflow.md` guidance policy and requires a structured `present_guidance` result. `bin/pi-guidance-loop` repeatedly runs guidance, executes `CONTINUE_WORK` prompts, applies `UPDATE_WORK` workboard updates, and stops on `REQUIRE_HUMAN_DECISION` or `EMPTY_WORKBOARD`.
- Ugo workboard loop: `/ugo` alternates ugo-guide and ugo-do phases in fresh sessions until `REQUIRE_HUMAN_DECISION`, `EMPTY_WORKBOARD`, commit failure, Escape, or `/ugo-pause`. Ugo creates `workflow.md` when missing and loads it as editable guidance policy for guide phases. Ugo requires a clean git worktree except for `workboard.md`, `workflow.md`, and `scratch/`, and commits changed files after each ugo-guide/ugo-do phase with the prompt, result, and automatic no-tools ugo-do reflection in the commit message. The reflection has `Retrospective` and `Simplify` notes; the complete reflection is injected into the next ugo-guide prompt so guidance can promote relevant improvements into workboard updates/items. Human-decision phases watch `workboard.md` and `scratch/decisions/*` for `DONE:` or `CLARIFY:` signals, apply the resulting workboard transition, and continue. Empty-workboard phases remain active and watch `workboard.md` for new work without creating decision artifacts. `/ugo` also resumes paused, human-decision, or empty-workboard state; `/ugo-pause` stops watchers immediately or pauses after the active phase safely checkpoints. See `HOWTO-UGO.md`.
- `#` prompt snippets: `#principles`, `#cut`, `#simplify`, `#delegate-review`, `#ts`, `#delegate-progress`, `#supervise`, `#api-review`, `#enrich`, `#distill`.
