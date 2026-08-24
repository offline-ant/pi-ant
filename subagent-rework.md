# Structured Worker Architecture

The orchestration layer requires Herdr 0.7.5 or newer and uses its named-agent CLI facade.

## Public tools

- `delegate`: runs one task in a temporary Herdr worker with required `context: "inherit" | "project" | "clean"`. Inherit forks before the tool call; project and clean create blank conversations. A delegate-only sibling batch executes concurrently and joins before the parent continues.
- `coding-agent`: runs tasks serially in a named persistent fresh-context Herdr worker and keeps the worker available for follow-up tasks.
- `fresh-history`: runs one isolated task with a requested excerpt of recent user requests and direct assistant replies. Tool activity is omitted.

`/herdr-fork` is a user command for opening an interactive forked session. It is not an LLM-callable tool.

## Shared worker protocol

All structured workers use the same explicit file protocol under `/tmp/pi-herdr-worker-*`:

1. The parent writes `request.json` and `prompt.md`.
2. The parent starts or reuses a named Herdr Pi agent.
3. The parent atomically submits `/worker-run <request.json>` with `herdr agent prompt`.
4. The child submits the request task as the user prompt.
5. The child's main result is saved to `result.md`.
6. The child runs a no-tools retrospective and saves it to `retrospective.md`.
7. The combined result is written atomically to `result.json`.
8. The parent waits for the matching request ID, then returns the main result and retrospective.

A request is complete only when the matching `result.json` exists. Named-agent state, pane output, idle state, and status files are liveness or progress signals, not completion signals. Herdr 0.7.5's `agent start` owns interactive readiness; pane IDs are retained only for output, diagnostics, and cleanup.

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

A structured request starts with automatic result capture. Normal human input sent directly in the worker changes the request to supervised capture before the input is delivered, so conversational replies no longer complete the parent request. `/worker-submit` submits the latest assistant reply (or explicit supplied text) for the pending result or retrospective phase. `/worker-continue <prompt>` instead sends guidance and preserves or restores automatic capture, allowing the eventual reply to complete through the normal parent-facing protocol without another manual submission. It preserves the current phase: result guidance can still determine the main result, while retrospective guidance cannot replace the already-saved main result. Submitting a main result starts a fresh automatic retrospective. Worker status reports supervised requests and both continuation choices to the child UI and waiting parent.

## Retry and failure behavior

- Retryable provider failures do not immediately write a result. The parent keeps waiting while Pi retries the request.
- When an automatic worker run—including its configured retries—ends without a main result, the worker remains open in supervised mode. The parent keeps waiting while the user opens the worker pane, types a message to retry or investigate, and submits the recovered reply with `/worker-submit`.
- If an automatic worker run ends without a retrospective, the successful main result is returned with an unavailable-retrospective note.
- Non-retryable provider failures write an error result once the automatic run settles, allowing Pi's context-overflow compaction recovery to finish first.
- A missing named agent is tolerated briefly during startup. An agent that disappears after becoming live is a worker failure, even if its former pane still exists.
- Cancelling `delegate` closes its temporary pane in every context mode.
- Cancelling `coding-agent` stops the parent wait but leaves the persistent worker available.
- `/worker-continue <prompt>` clears stale supervised capture state, sends the prompt as steering guidance, and resumes automatic capture without waiting for the current turn to settle.
- `/worker-submit [message]` waits for the current turn to settle, then submits the latest supervised reply or supplied text through the normal result/retrospective protocol.
- `/finish-worker-now "message"` aborts the active worker turn, writes the supplied result immediately, and records that the retrospective was bypassed.

## Context and tools

- `delegate` with `context: "inherit"` inherits the current conversation and ordinary active parent tools, excluding unavailable control tools. Use it when the task depends on context established in the current conversation. Under the `bobs` profile it instead receives the deterministic Research tool profile. It retains `delegate` for bounded nested delegation.
- `delegate` with `context: "project"` creates a blank conversation with normal project/global startup resources but no conversation history. Its task must include all relevant conversation-specific requirements, decisions, paths, findings, and constraints. `context: "clean"` also creates a blank conversation but disables discovered context files, skills, prompt templates, extensions, and custom system prompts, explicitly loading only the worker-frame extension required by the result protocol. Fresh delegates remove one-shot and persistent worker tools.
- Above 50% parent context usage, the first inherited delegate on a conversation branch returns a model-visible recommendation to use `project` and does not start a worker. Retrying `inherit` proceeds without another warning. Unknown context usage does not trigger the check.
- Every spawned Pi process explicitly receives the parent's current provider, model, and thinking level. There is no separate worker model state or model-selection fallback. Delegate-only sibling work may overlap, but child Pi startup is serialized to avoid provider-authentication races. A batch containing `coding-agent` or `fresh-history` remains sequential.
- The root `/tools` selector controls branch-persistent ordinary-session tool exposure without changing structured-worker or Ugo tool ownership.

## Runtime state

- `/tmp/pi-herdr-worker-*`: request, result, retrospective, status, and diagnostic artifacts.
- `/tmp/pi-herdr-coding-agents`: persistent coding-agent registry and claims.
- `/tmp/pi-herdr-panels`: named long-running panel registry.

The implementation intentionally has no compatibility layer for the retired tmux/semaphore worker protocol.
