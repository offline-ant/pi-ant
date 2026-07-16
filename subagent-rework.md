# Structured Worker Architecture

## Public tools

- `delegate`: runs one task in a temporary Herdr worker with required `context: "inherit" | "project" | "clean"`. Inherit forks before the tool call; project and clean create blank conversations. Independent fresh-context calls may run in parallel.
- `coding-agent`: runs tasks serially in a named persistent fresh-context Herdr worker and keeps the worker available for follow-up tasks.
- `fresh-history`: runs one isolated task with a requested excerpt of recent user requests and direct assistant replies. Tool activity is omitted.

`/herdr-fork` is a user command for opening an interactive forked session. It is not an LLM-callable tool.

## Shared worker protocol

All structured workers use the same explicit file protocol under `/tmp/pi-herdr-worker-*`:

1. The parent writes `request.json` and `prompt.md`.
2. The parent starts or reuses a Herdr Pi pane.
3. The parent sends `/worker-run <request.json>`.
4. The child submits the request task as the user prompt.
5. The child's main result is saved to `result.md`.
6. The child runs a no-tools retrospective and saves it to `retrospective.md`.
7. The combined result is written atomically to `result.json`.
8. The parent waits for the matching request ID, then returns the main result and retrospective.

A request is complete only when the matching `result.json` exists. Pane output, idle state, and status files are progress signals, not completion signals.

```ts
interface WorkerRequestFile {
  id: string;
  task: string;
  resultPath: string;
  closeWhenDone: boolean;
  statusPath?: string;
}

interface WorkerResultFile {
  id: string;
  result: string;
  retrospective?: string;
  isError?: boolean;
  sessionFile?: string;
  timestamp: string;
  contextPercent?: number | null;
}
```

Workers return the main result followed by the automatic retrospective, including `everything was ok` when there are no additional observations.

A structured request starts with automatic result capture. Normal human input sent directly in the worker changes the request to supervised capture before the input is delivered, so conversational replies no longer complete the parent request. `/worker-submit` submits the latest assistant reply (or explicit supplied text) for the pending result or retrospective phase. Submitting a main result starts a fresh automatic retrospective. Worker status reports supervised requests to both the child UI and the waiting parent.

## Retry and failure behavior

- Retryable provider failures do not immediately write a result. The parent keeps waiting while Pi restarts the request.
- If retry does not restart within the grace period, the worker writes an error result.
- A missing pane is tolerated briefly during startup. A pane that disappears after becoming live is a worker failure.
- Cancelling `delegate` closes its temporary pane in every context mode.
- Cancelling `coding-agent` stops the parent wait but leaves the persistent worker available.
- `/worker-submit [message]` waits for the current turn to settle, then submits the latest supervised reply or supplied text through the normal result/retrospective protocol.
- `/finish-worker-now "message"` aborts the active worker turn, writes the supplied result immediately, and records that the retrospective was bypassed.

## Context and tools

- `delegate` with `context: "inherit"` inherits the current conversation and ordinary active parent tools, excluding unavailable control tools. Use it when the task depends on context established in the current conversation. Under the `bobs` profile it instead receives the deterministic Research tool profile. It retains `delegate` for bounded nested delegation.
- `delegate` with `context: "project"` creates a blank conversation with normal project/global startup resources but no conversation history. Its task must include all relevant conversation-specific requirements, decisions, paths, findings, and constraints. `context: "clean"` also creates a blank conversation but disables discovered context files, skills, prompt templates, extensions, and custom system prompts, explicitly loading only the worker-frame extension required by the result protocol. Fresh delegates remove one-shot and persistent worker tools.
- Above 50% parent context usage, the first inherited delegate on a conversation branch returns a model-visible recommendation to use `project` and does not start a worker. Retrying `inherit` proceeds without another warning. Unknown context usage does not trigger the check.
- `/subagent-model` optionally overrides the model used by spawned workers, including `/herdr-fork` unless that command supplies explicit Pi arguments.
- The root `/tools` selector controls branch-persistent ordinary-session tool exposure without changing structured-worker or Ugo tool ownership.

## Runtime state

- `/tmp/pi-herdr-worker-*`: request, result, retrospective, status, and diagnostic artifacts.
- `/tmp/pi-herdr-coding-agents`: persistent coding-agent registry and claims.
- `/tmp/pi-herdr-panels`: named long-running panel registry.

The implementation intentionally has no compatibility layer for the retired tmux/semaphore worker protocol.
