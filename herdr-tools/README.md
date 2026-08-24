# herdr-tools

Herdr-backed Pi orchestration tools. This package is the Herdr-native sibling of `tmux-tools/` and is loaded separately from `~/.pi/agent/settings.json`.

## Requirements

- Pi must run inside a Herdr pane (`HERDR_ENV=1` and `HERDR_SOCKET_PATH` set).
- Herdr 0.7.5 or newer must be on `PATH`, or `HERDR_BIN_PATH` must point at the running Herdr binary.
- Install Herdr's Pi integration for better worker state in the sidebar:

```bash
herdr integration install pi
```

## Shape

Use Herdr's `SKILL.md` / agent instructions for general pane, tab, workspace, remote, read, send, and wait operations. This package adds dedicated tools for the workflows where tool shape matters:

- panel tools for long-running commands and log capture
- the `/herdr-fork` command for an interactive current-session fork
- Pi-specific worker tools (`delegate`, `coding-agent`, `fresh-history`)

## Panel tools

Use these tools for long-running commands and interactive panel control:

- `herdr-bash` — create a named Herdr panel and run a command in it. Use for servers, watchers, long builds, and background processes.
- `herdr-capture` — capture output from a named Herdr panel, pane id, or stable terminal id. By default it returns new output since the last capture when possible. Pass `close: true` to capture final output and close the panel.
- `herdr-send` — send text, a command, or key presses such as `ctrl+c` to a named Herdr panel, pane id, or stable terminal id.

Command:

- `/herdr-panels` — list the local panel registry.

`herdr-bash` always opens a new tab in the current workspace. It intentionally has no placement/direction knobs; if you need custom layout, use Herdr CLI/skill operations directly.

`herdr-bash` accepts an optional `waitFor` readiness check. Prefer that over separate polling when you are starting a server and need to wait for `ready`, `listening`, or a local URL. Panel names are unique while their registered pane is alive, preventing accidental orphan tabs.

## Session fork

`/herdr-fork <name> [folder] [-- <prompt>]` forks the current session into a new interactive Pi agent in a separate Herdr tab. Names follow Herdr's strict agent-name format (`^[a-z][a-z0-9_-]{0,31}$`). If `prompt` is omitted, the forked tab opens idle. Interactive forks can create further forks, subject to the global Pi nesting-depth limit.

`herdr-fork` is intentionally a user command, not an LLM-callable tool. Use it when the user wants an interactive tab continuing from the current session. Use `delegate`, `coding-agent`, or `fresh-history` when the parent needs a structured worker result.

## Worker tools

- `delegate` — run one ephemeral task with an explicit required context mode:
  - `inherit` forks immediately before the tool call and preserves the parent conversation, working directory, and delegated tool policy. Use it when the task depends on context established in the current conversation.
  - `project` creates a blank conversation and loads normal project/global startup resources. Its task must be self-contained because it receives no conversation history; include all relevant requirements, decisions, paths, findings, and constraints.
  - `clean` creates a blank conversation in the requested working directory while disabling discovered context files, skills, prompt templates, extensions, and custom system prompts.
- `coding-agent` — run a task in a named persistent fresh-context Herdr worker in a separate tab.
- `fresh-history` — run one task in an ephemeral fresh Herdr worker seeded with only recent user requests and direct assistant replies. Tool calls/results are omitted, and the prompt includes the parent Pi session file plus session history root for critical recovery.

`context` is required on `delegate`. Every spawned Pi process explicitly inherits the parent's current provider, model, and thinking level. A delegate-only sibling batch executes concurrently and joins before the parent continues; child Pi startups are serialized so they cannot race provider authentication. A batch containing `coding-agent` or `fresh-history` remains sequential. `folder` may select another working directory for `project`/`clean`; inherited delegates accept only the parent's current directory. Inherited delegates fork before their own tool-call message, so sibling tool results are not present in the worker.

When the parent conversation is over 50% of its context window, the first inherited delegate on a conversation branch is not started. Its tool result recommends a self-contained `project` delegate instead. Retrying with `inherit` proceeds normally, and the warning is not repeated on that branch. The check is skipped when Pi cannot determine current context usage.

After saving the main result, each structured worker runs a no-tools retrospective. The parent receives both outputs, including `everything was ok` when there are no additional observations; `result.md` and `retrospective.md` retain them separately.

Typing a normal message directly in an active worker automatically puts that request under human supervision. Subsequent replies stay in the worker instead of completing the parent request. When a retryable or cancelled automatic worker run—including its configured retries—ends without a main result, the worker also enters this supervised mode; open the worker pane and type a message to retry or investigate. `/worker-submit` sends the latest assistant reply to the parent-facing protocol; while the main result is pending it submits that result and starts the automatic retrospective, and while a retrospective is pending it submits that retrospective. `/worker-submit <message>` supplies explicit text instead. `/worker-continue <prompt>` sends guidance while preserving or restoring automatic capture, so the worker's eventual reply continues through the normal result and retrospective protocol without another manual submission. During the retrospective phase it cannot replace the already-saved main result. The child status and the waiting parent progress identify supervised requests, the retry failure that caused automatic supervision, and both ways to continue. If an automatic worker run ends without a retrospective, the successful main result is returned with an unavailable-retrospective note.

Clean delegates explicitly load only the internal worker-frame extension needed by the result protocol. Consequently, models/providers registered exclusively by other extensions are unavailable in that mode; use `project` when those runtime extensions are required.

Commands:

- `/worker-continue <prompt>` — send guidance and preserve or restore automatic completion.
- `/worker-submit [message]` — submit the latest supervised reply or explicit text, preserving the normal retrospective protocol.
- `/finish-worker-now "message"` — recovery command that immediately returns explicit text and bypasses retrospective.

Root orchestration behavior is the `bobs` profile in the main package's `/tools` selector. It restricts root tools to delegation and gives inherited `delegate` workers the deterministic Research tool profile.

## Runtime state

Runtime files are written under `/tmp`:

- `/tmp/pi-herdr-panels` — named panel registry.
- `/tmp/pi-herdr-worker-*` — structured worker artifacts.
- `/tmp/pi-herdr-coding-agents` — persistent coding-agent registry.

Each child starts as a named Herdr Pi agent in a newly created tab. `herdr agent start` owns interactive readiness, and `herdr agent prompt` atomically submits `/worker-run <request.json>`. The matching `result.json` remains the only completion signal; named-agent state is used only for liveness, while pane IDs remain available for output, diagnostics, and cleanup.
