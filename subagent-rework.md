# Subagent Rework

## Goal

Keep the tool model simple and clean:

- `call`: current-context worker. Forks the current conversation, runs one task, returns a result, exits.
- `coding-agent`: fresh-context persistent worker. Runs one task at a time in a named tmux pane, returns the result, stays alive for follow-up tasks.
- `minitask`: fresh-context one-shot worker. Runs one small isolated task, returns the result, exits.

Use `retrospective` everywhere. Do not add `reflect` naming.

Replace the old `tmux-coding-agent` async loop. It was rarely used. The new `coding-agent` should pause until the task returns; no `tmux-coding-agent` + `tmux-send` + `semaphore_wait` workflow as the main path.

Design principles for the implementation:

- Do the hard part first.
- Clean up as we go.
- Leave no dead code or compatibility shims behind.
- Being broken between phases is acceptable if moving toward the right final design.
- Prefer the well-designed long-term architecture over quick fixes.
- Keep names strict and consistent.

## Public Tools

### `call`

Current-context delegation.

```ts
{
  task: string;
  complex?: boolean;
  retrospective?: boolean;
}
```

Behavior:

1. Fork current session before the `call` tool call.
2. Start a tmux worker from that fork.
3. Run the task.
4. Wait for an explicit result file.
5. Return the result.
6. Shut down the worker.

Keep `complex` with its current meaning: nested `call` is available only when explicitly enabled.

### `coding-agent`

Fresh-context persistent worker.

```ts
{
  name: string;
  task: string;
  folder?: string;
  retrospective?: boolean;
}
```

Behavior:

1. If `name` does not exist, start a fresh-context pi session in tmux.
2. If `name` exists and is idle, send it the task as follow-up work.
3. If `name` exists and is busy, fail clearly.
4. Wait for this task's explicit result file.
5. Return the result plus worker metadata.
6. Keep the worker alive.

Fresh-context means: do not fork the parent conversation. The worker loads normal project/global instructions from startup.

Keep this simple initially:

- `folder` defaults to current cwd.
- No `piArgs` in the first pass unless clearly needed. Use `/tool-model` behavior consistently with existing tool workers.
- If an existing worker is reused with a different `folder`, reject.
- Do not expose async mode.
- Do not expose nested `call` from `coding-agent` initially. Add it later only if there is a real use case.

Returned shape:

```md
## Result
...

---
Worker: planner
Status: idle
Context: 34.2%
Session: /home/claude/.pi/agent/sessions/...
Artifacts: /tmp/pi-ant-worker-...
```

### `minitask`

Fresh-context one-shot.

```ts
{
  task: string;
  simple?: boolean;
  retrospective?: boolean;
}
```

Behavior:

1. Start a fresh temporary tmux worker pane.
2. Run the task.
3. Optionally run retrospective.
4. Return result.
5. Kill/dispose the worker.

This should use the same tmux worker scheme as `call` and `coding-agent`, not RPC. Keep `simple` behavior: when `simple: true` and `/tool-model` is not active, preserve the current fast-model fallback sequence.

## Shared Worker Result Scheme

Use one simple internal result protocol for all three tools.

### Request transport

Use an internal child command instead of hidden prompt envelopes:

```text
/worker-run /tmp/pi-ant-worker-abc/request.json
```

The parent writes `request.json`, then sends that short command to the worker pane. The child command reads the file and submits the real task.

Request file:

```ts
interface WorkerRequestFile {
  id: string;
  task: string;
  resultPath: string;
  retrospective?: boolean;
  closeWhenDone: boolean;
}
```

This is simpler than putting metadata in a normal prompt:

- no model-visible XML envelope
- no prompt parsing
- short tmux send text
- inspectable request files
- same path for `call`, `coding-agent`, and `minitask`

### Parent side

For each task:

1. Create an artifact directory under `/tmp/pi-ant-worker-*`.
2. Create a unique request ID.
3. Write `request.json`.
4. Send `/worker-run <request.json>` to the worker.
5. Wait until `result.json` exists and matches the request ID.
6. Return that result.

### Child side

`/worker-run`:

1. Reads `request.json`.
2. Stores the active request.
3. Sends the request's `task` as the actual user prompt.
4. On final assistant text, optionally runs retrospective.
5. Writes `result.json` atomically.
6. If `closeWhenDone`, shuts down. Otherwise marks the worker idle.

### Result file

```ts
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

That's enough for the first version.

## Retrospective

Use the same prompt everywhere:

```text
The main result has already been saved for the parent. Do not repeat it, do not continue the task, and do not call tools.
Return only substantial observations you noticed outside of the given task, or substantial things you did not mention regarding it, that are worth taking into account or fixing in the long run.
If there is nothing substantial, return exactly: everything was ok
```

Output format:

```md
<main result>

---

Retrospective:
<retrospective text>
```

If retrospective fails, keep the main result and append:

```text
retrospective unavailable: <reason>
```

Do not run retrospective after a failed main task.

## Retry / Websocket Error Rule

Never treat semaphore release, lock idleness, or pane output as task success.

A task is done only when the matching `result.json` exists.

This fixes the websocket `(1/3)` issue: retryable errors must not produce a result file. The parent should keep waiting unless the pane exits or the user cancels.

Simple behavior:

- Matching `result.json`: return it.
- Pane exits before result: return/throw worker failure with captured pane output.
- Retryable provider error: write no result; keep waiting.
- Parent cancels `call`: close the call worker.
- Parent cancels `coding-agent`: stop waiting, but leave the persistent worker alone.

## Implementation Plan

### Phase 1: Build the shared worker path

Create `extensions/worker-frame.ts` with only the basics:

- create artifact dir
- make request ID
- write `request.json`
- register `/worker-run`
- track the active request in the child
- write result atomically
- read/validate result
- format result with retrospective
- wait for result while checking pane liveness

Move duplicated call result/artifact code into this helper.

### Phase 2: Fix `call` on top of the shared helper

Keep the public API the same.

Make `call` use the shared result helper and preserve current behavior:

- current-context fork
- tmux pane
- explicit result file
- optional retrospective
- shutdown after result

Also fix retry handling so retryable provider errors do not look like completion.

### Phase 3: Add `coding-agent`

Create `extensions/coding-agent.ts`.

Register `coding-agent` and remove public `tmux-coding-agent` registration.

Implementation:

- maintain a small in-memory plus `/tmp` registry: `name -> lockName, sessionFile, cwd, statusPath`
- start fresh `SessionManager.create(cwd)` for new workers
- start tmux session-agent
- send tasks with `/worker-run <request.json>`, not raw multiline `tmux-send`
- reject if worker is busy
- reject if caller reuses the same name with a different folder
- wait for matching result
- return result and metadata
- keep worker alive

No lifecycle commands in the first pass unless they are needed to make the tool usable. Existing `tmux-kill` can kill a pane manually.

### Phase 4: Port `minitask` to the shared worker path

Remove the RPC minitask implementation.

Implement `minitask` as an ephemeral fresh-context tmux worker:

- create fresh session
- start worker pane
- send `/worker-run <request.json>` with `closeWhenDone: true`
- wait for result
- kill/cleanup the pane if needed

Keep the public `simple?: boolean` option and preserve its existing fast-model fallback behavior when `/tool-model` is not active.

### Phase 5: Clean docs and names

Update:

- `README.md`
- `HOWTO-CALL-MODE.md`
- tool descriptions
- package extension registration

Remove old `tmux-coding-agent` public guidance. Keep low-level `tmux-bash`, `tmux-capture`, `tmux-send`, and `tmux-kill`.

## Non-goals

- Preserve the old `tmux-coding-agent` async workflow.
- Add compatibility shims.
- Add `reflect` naming.
- Build a large worker orchestration framework.
- Add lifecycle/list/reset commands before the core tools work cleanly.
