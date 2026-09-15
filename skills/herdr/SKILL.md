---
name: herdr
description: "Control Herdr panes, tabs, workspaces, ordinary commands, and recognized agents through its CLI. Use when the user asks to inspect or control Herdr. Requires HERDR_ENV=1. Use Pi orchestration tools for managed Pi workers and panels."
---

# Herdr

Before inspecting or controlling a session, verify that you are inside a Herdr-managed pane:

```bash
test "${HERDR_ENV:-}" = 1
```

If this fails, stop; do not inspect or control an outside user's focused session. Updating the binary is a separate operation performed outside Herdr, as described below.

## Local Pi orchestration policy

Use `delegate`, `coding-agent`, `/fork-here`, and the `panel-*` tools for managed Pi workers, forks, and shell panels. They preserve ownership, explicit host/socket identity, result collection, and cleanup.

Managed Pi prompts must use orchestration's private terminal-input socket, not `herdr agent prompt`, `pane run`, or text/key injection. Native terminal input appends to human drafts; Herdr 0.9.0's improved prompt delivery does not provide draft isolation. Do not bypass the worker protocol or treat a Herdr lifecycle state as a matching worker result.

The raw CLI examples below are for explicitly requested Herdr operations outside that managed workflow. Send input only to an owned, available terminal or agent, not a user's draft or approval dialog.

## Learn the installed CLI

The installed binary is authoritative for syntax:

```bash
herdr --help
herdr pane
herdr agent
herdr workspace
herdr tab
```

Use `--help` for nested commands. Do not run bare `herdr` for discovery: it launches or attaches the TUI. Do not probe mutating commands by omitting arguments; commands such as `workspace create` execute with defaults.

This guide reflects stable 0.9.0. Client and server versions may differ after updating. Check `herdr status` before relying on new server features; a missing method does not authorize restarting a server.

## Concepts and caller identity

Workspaces contain tabs; tabs contain terminal panes. Pane commands operate on raw terminals, including ordinary shells, servers, and tests. Agent commands operate on the recognized agent currently occupying a pane.

Public IDs are opaque handles, for example `w1`, `w1:t1`, and `w1:p1`. Parse returned IDs; never derive them from sidebar order or substitute these examples. Closed tab/pane IDs are not reused. Moving a pane across workspaces changes its qualified ID: use `.result.move_result.pane.pane_id` from the move response or its live agent name afterward.

Herdr injects caller context:

```bash
printf '%s\n' "$HERDR_WORKSPACE_ID" "$HERDR_TAB_ID" "$HERDR_PANE_ID"
herdr pane current --current
herdr workspace list
herdr tab list --workspace "$HERDR_WORKSPACE_ID"
herdr pane list --workspace "$HERDR_WORKSPACE_ID"
herdr agent list
```

The focused pane is not necessarily yours. Prefer `--current` for the calling pane or an explicit returned ID for another pane. IDs and agent names are scoped to one server. TUI machine selection does not retarget your inherited socket; never reuse IDs across servers.

Agent names match `[a-z][a-z0-9_-]{0,31}` and must be unique among live agents. They belong to the current occupant and are cleared on exit, release, or replacement. Agent targets accept a live name or its hosting pane ID, not a terminal ID or bare agent-kind label.

`agent_status` is `idle`, `working`, `blocked`, `done`, or `unknown`. Both `idle` and `done` indicate readiness for input. CLI/API Done uses server seen state; explicit focus marks it seen, but reads do not. In 0.9.0, each TUI client tracks viewed completions independently, so its Done badge may differ from CLI/API or another client. `blocked` indicates an approval/question UI; `unknown` does not prove completion.

## Create a sibling and run an ordinary command

Default to the caller's tab and working directory unless the user requests other topology. Honor requested direction; otherwise inspect geometry and split wide panes right, narrow/tall panes down:

```bash
herdr pane layout --pane "$HERDR_PANE_ID"
NEW_PANE=$(herdr pane split --current --direction right --cwd "$PWD" --no-focus | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["pane"]["pane_id"])')
herdr pane run "$NEW_PANE" "npm run dev"
herdr pane wait-output "$NEW_PANE" --match "ready" --timeout 30000
herdr pane read "$NEW_PANE" --source recent-unwrapped --lines 80
```

Only use `pane run` at an available shell prompt. It sends text and Enter as one request. To send literal text without Enter or intentional terminal keys:

```bash
herdr pane send-text "$NEW_PANE" "echo hello"
herdr pane send-keys "$NEW_PANE" Enter
```

## Read and wait for output

```bash
herdr pane read "$NEW_PANE" --source recent --lines 50
herdr pane wait-output "$NEW_PANE" --regex 'server.*ready' --timeout 30000
```

- `visible`: current rendered viewport.
- `recent`: recent rendered output with soft wraps.
- `recent-unwrapped`: recent text with soft wraps joined, preferred for logs.
- `detection`: bottom-buffer evidence used for agent detection (read source).
- `--format ansi`: rendered styling evidence; otherwise prefer text.

`pane wait-output` takes either `--match <text>` or `--regex <pattern>`, not both. It searches the selected snapshot immediately, including existing output, then polls; it does not wait only for new output. Its default `recent` matching joins soft wraps. Use unique readiness markers to avoid stale matches. Omitting `--timeout` waits indefinitely. The retired `herdr wait output` command is not valid.

Increasing `--lines` cannot recover text lost from an application's alternate screen. If needed, ask the agent to save its complete answer to a temporary Markdown file, then read that file; do not repeatedly resend the original task.

## Start and coordinate an unmanaged agent

For managed Pi workers, use the orchestration tools above instead. For an explicitly requested native agent, create an owned sibling shell pane as above, then use a unique name and the requested kind:

```bash
herdr agent start reviewer --kind codex --pane "$NEW_PANE"
```

`agent start` never creates topology. It requires an interactive shell prompt and waits for the expected agent to be detected and ready (default 30 seconds). Pass native arguments after `--`. If startup returns `agent_not_ready`, inspect the named agent; do not type through onboarding or approval prompts without user consent.

For an owned agent with no human draft:

```bash
herdr agent prompt reviewer "Review the test coverage in src/api/." --wait --timeout 120000
herdr agent get reviewer
herdr agent read reviewer --source recent-unwrapped --lines 120
```

`agent prompt` rejects already-blocked agents before sending input. In 0.9.0 it reports submission only after writing prompt and Enter, which alone does not prove a turn started. With `--wait`, a non-working agent must show `working` or `blocked` activity within five seconds, otherwise `agent_prompt_stalled` is returned (or an earlier caller timeout). The default settled states are `idle`, `done`, or `blocked`. This follows lifecycle state, not individual turns; a currently active turn may satisfy the wait if the agent was already working.

Wait independently, or request a specific state only when needed:

```bash
herdr agent wait reviewer --timeout 120000
herdr agent wait reviewer --until blocked --timeout 120000
```

The retired `herdr wait agent-status` command is not valid. A timeout or stalled response does not prove input was undelivered: inspect before retrying. For intentional interactive controls, use `herdr agent send-keys reviewer esc` or `ctrl+c`; inspect blocked UI and ask before answering it.

## Tabs and workspaces

Create other topology only when requested. Parse each response rather than guessing IDs:

```bash
herdr tab create --workspace "$HERDR_WORKSPACE_ID" --label logs --no-focus
herdr workspace create --cwd /path/to/project --label "api server" --no-focus
```

`tab create` returns `.result.tab` and `.result.root_pane`. `workspace create` returns `.result.workspace`, `.result.tab`, and `.result.root_pane`. A split returns `.result.pane`.

Use the returned IDs in these forms; angle-bracket arguments are placeholders, not literal shell commands:

```text
herdr tab rename <tab-id> "logs"
herdr tab focus <tab-id>
herdr tab close <tab-id>
herdr workspace rename <workspace-id> "api server"
herdr workspace focus <workspace-id>
herdr workspace close <workspace-id>
herdr pane close <pane-id>
```

Without `--label`, tabs keep numbered names and workspaces use cwd-based names. Keep `--no-focus` for background creation unless the user requests a focus change.

## Safety and updates

- Never close panes, tabs, workspaces, or sessions you did not create unless explicitly requested.
- In 0.9.0, closing a primary workspace with linked worktree workspaces requires `workspace close --group` (API: `close_group: true`). This closes the entire group. Never add it merely to bypass `workspace_group_close_required`; obtain explicit group-close intent.
- Never kill the main Herdr process. Use disposable named sessions for experiments.
- Run `herdr update` from an outside terminal after detaching. Do not clear inherited Herdr variables to bypass its inside-session safeguard. Respect any confirmation to stop incompatible servers; updating the binary is not permission to terminate pane processes.
- Never run `herdr server stop` in an active session unless the user explicitly intends to stop the server and all its pane processes. Do not opt into experimental handoff without approval.
- Lifecycle subscriptions in 0.9.0 start with live events, not retained history. Subscribe before taking an initial snapshot to avoid gaps.
- Most control commands return JSON; `pane read` defaults to text. `pane send-text`, `pane send-keys`, and `pane run` are silent on success. Server errors are JSON on stderr with exit status 1; syntax errors exit with status 2.
