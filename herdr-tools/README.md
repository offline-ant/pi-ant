# herdr-tools

Herdr-backed Pi orchestration tools. This package is the Herdr-native sibling of `tmux-tools/` and is loaded separately from `~/.pi/agent/settings.json`.

## Requirements

- Pi must run inside a Herdr pane (`HERDR_ENV=1` and `HERDR_SOCKET_PATH` set).
- `herdr` must be on `PATH`, or `HERDR_BIN_PATH` must point at the running Herdr binary.
- Install Herdr's Pi integration for better worker state in the sidebar:

```bash
herdr integration install pi
```

## Shape

Use Herdr's `SKILL.md` / agent instructions for general pane, tab, workspace, remote, read, send, and wait operations. This package adds dedicated tools for the workflows where tool shape matters:

- panel tools for long-running commands and log capture
- the `/herdr-fork` command for an interactive current-session fork
- Pi-specific worker tools (`call`, `coding-agent`, `minitask`, `fresh-history`)

## Panel tools

Use these tools for long-running commands and interactive panel control:

- `herdr-bash` — create a named Herdr panel and run a command in it. Use for servers, watchers, long builds, and background processes.
- `herdr-capture` — capture output from a named Herdr panel or pane id. By default it returns new output since the last capture when possible.
- `herdr-send` — send text or a command to a named Herdr panel or pane id. Use for Ctrl-C/restarts or interactive prompts.
- `herdr-close` — close a named Herdr panel or pane id and remove it from the local registry.

Command:

- `/herdr-panels` — list the local panel registry.

`herdr-bash` always opens a new tab in the current workspace. It intentionally has no placement/direction knobs; if you need custom layout, use Herdr CLI/skill operations directly.

`herdr-bash` accepts an optional `waitFor` readiness check. Prefer that over separate polling when you are starting a server and need to wait for `ready`, `listening`, or a local URL.

## Session fork

`/herdr-fork <name> [folder] [--pi-args <args>] [-- <prompt>]` forks the current session into a new interactive Pi agent in a separate Herdr tab. If `prompt` is omitted, the forked tab opens idle.

`herdr-fork` is intentionally a user command, not an LLM-callable tool. Use it when the user wants an interactive tab continuing from the current session. Use `call`, `coding-agent`, `minitask`, or `fresh-history` when the parent needs a structured worker result.

## Worker tools

- `call` — run a delegated current-context task in a forked Herdr Pi worker in a separate tab and return the result.
- `coding-agent` — run a task in a named persistent fresh-context Herdr worker in a separate tab.
- `minitask` — run one isolated fresh-context task in an ephemeral Herdr worker in a separate tab.
- `fresh-history` — run one task in an ephemeral fresh Herdr worker seeded with only recent user requests and direct assistant replies. Tool calls/results are omitted, and the prompt includes the parent Pi session file plus session history root for critical recovery.

After saving the main result, each structured worker runs a no-tools retrospective. The parent receives both outputs, including `everything was ok` when there are no additional observations; `result.md` and `retrospective.md` retain them separately.

Commands:

- `/bobs-mode [on|off|status|toggle]` — restrict root tools to orchestration tools.
- `/finish-call-now "message"` — child-frame recovery command for active worker requests.
- `/set-tool-model`, `/tool-model` — configure model overrides for spawned Pi workers.

## Runtime state

Runtime files are written under `/tmp`:

- `/tmp/pi-herdr-panels` — named panel registry.
- `/tmp/pi-herdr-worker-*` — structured worker artifacts.
- `/tmp/pi-herdr-coding-agents` — persistent coding-agent registry.

The worker protocol still uses `/worker-run <request.json>` inside the child Pi pane. The Herdr layer only replaces pane creation, input, reading, waiting/progress, and cleanup.
