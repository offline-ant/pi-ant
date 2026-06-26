# Subagent Tool Rework Proposal

## Goal

Replace the current split between `call`, RPC-backed `minitask`, and the mostly-asynchronous `tmux-coding-agent` workflow with a coherent set of structured subagent tools.

The target model:

- `call`: current-context delegated worker. Forks the current conversation context, runs a task in tmux, returns a structured result, and exits.
- `coding-agent`: fresh-context persistent worker. Opens or reuses a named tmux worker, sends one task, waits until that task returns a structured result, keeps the worker alive for follow-up work, and reports context usage.
- `minitask`: one-shot fresh-context worker. Runs one isolated task and returns only its structured answer.

All three should support `retrospective`, using the same semantics as far as the backend allows. The earlier `reflect` wording was a typo; do not add a `reflect` option, `reflect*` field names, or `reflect.md` artifacts.

The current `tmux-coding-agent` async loop can be replaced. Keeping compatibility is not a goal. It was rarely used, and the new `coding-agent` should be synchronous from the caller's perspective: invoking the tool blocks until that specific task has produced a result.

## Tool Semantics

### `call`

Purpose: delegate work that needs the parent session's current context.

Behavior:

1. Fork the current session from just before the unresolved `call` tool call.
2. Start a tmux pane using that forked session.
3. Send the task through the shared worker-frame request protocol.
4. Wait for an explicit structured result file with the matching request ID.
5. Return the result to the parent.
6. Shut down the worker after result collection.

Schema should remain close to current:

```ts
{
  task: string;
  complex?: boolean;
  retrospective?: boolean;
}
```

`complex` keeps its current meaning: allow nested `call` inside the worker only when explicitly requested.

### `coding-agent`

Purpose: perform fresh-context operational work in a persistent named worker that can receive later follow-up tasks.

This replaces the current `tmux-coding-agent` tool. The old async pattern of `tmux-coding-agent` + `tmux-send` + `semaphore_wait` + `tmux-capture` should no longer be the primary path.

Behavior:

1. Always use a fresh context when a named coding agent is created.
   - Do not fork the current conversation context.
   - The worker still loads project/global instructions normally through pi startup.
2. Start a named tmux pane if no live worker with that name exists.
3. If the named worker exists and is idle, send the task into that same session as follow-up work.
4. If the named worker is currently busy, fail clearly rather than using hidden queueing.
5. Wait until that specific task writes a structured result file.
6. Return the result, worker identity, session file, artifact paths, and context usage.
7. Keep the worker alive after returning.

Proposed schema:

```ts
{
  name: string;
  task: string;
  folder?: string;
  piArgs?: string[];
  retrospective?: boolean;
}
```

Notes:

- `folder` defaults to the current working directory.
- `piArgs` is an argv array, not a shell string. This avoids shell quoting ambiguity and command-injection hazards. If omitted, `/tool-model` settings are applied.
- No async-only mode is needed.
- Reuse with a different `folder` or `piArgs` must fail clearly. A name identifies one persistent worker configuration.
- Nested `call` availability is a deliberate policy choice, not an accidental consequence of the normal tool set. Initial proposal: strip `call` from `coding-agent` workers unless a future explicit option enables it.

The returned text should be compact but include enough metadata for follow-ups:

```md
## Result
...

---
Worker: planner
Status: idle
Context: 34.2% (12345 / 36000 tokens)
Session: /home/claude/.pi/agent/sessions/...
Artifacts: /tmp/pi-ant-worker-...
```

### `minitask`

Purpose: isolated one-shot answer for small independent questions or review.

Schema:

```ts
{
  task: string;
  simple?: boolean;
  retrospective?: boolean;
}
```

Initial implementation can keep the current RPC backend and add `retrospective`. Later it can be moved onto the same worker-frame infrastructure if that reduces duplication or if strict no-tools retrospective parity is required.

Behavior:

1. Start an isolated fresh-context worker.
2. Send the task.
3. Wait for completion.
4. If `retrospective: true` and the main answer succeeded, run a second retrospective prompt.
5. Return the task answer plus retrospective.
6. Exit/dispose the worker.

Short-term caveat: the current RPC backend may not support strict no-tools mode for the retrospective phase. If it cannot disable tools, document that limitation and use a strong no-tools prompt until `minitask` is ported to the worker-frame backend.

## Shared Worker-Frame Protocol

Create a shared internal implementation for structured tmux workers, likely in:

```text
extensions/worker-frame.ts
```

This module should own:

- request IDs and nonces
- artifact directory creation
- result/status file paths
- prompt-file transport
- tmux launch/reuse
- worker registry lookup
- atomic worker claiming
- result polling and cancellation
- child-side active request state
- retrospective phase handling
- context-usage reporting
- retry-safe completion handling

### Request object and activation guard

A child-side worker-frame hook may run in every pi instance, so request activation must be gated. A normal user prompt must not be able to spoof an envelope and make the extension write arbitrary paths.

Use all of these guards:

- Parent starts structured workers with a trusted env var, for example `PI_ANT_WORKER=true`.
- Parent writes a per-process/session nonce into the worker session metadata or environment.
- Every request envelope includes that nonce.
- Child accepts a request only when the env var is present, nonce matches, and paths are inside the worker artifact root created by the parent.

Parent sends a machine-readable request envelope via a prompt file or dedicated tmux helper, not raw `tmux-send` text. Raw `tmux-send` is brittle for multiline prompts, quoting, TUI state, and existing input detection.

Example request file content:

```text
<pi-ant-worker-request>
{
  "id": "...",
  "nonce": "...",
  "kind": "coding-agent",
  "resultPath": "/tmp/pi-ant-workers/.../result.json",
  "statusPath": "/tmp/pi-ant-workers/.../status.json",
  "retrospective": true,
  "closeWhenDone": false
}
</pi-ant-worker-request>

Task:
...
```

For `call`, `closeWhenDone` is true.
For `coding-agent`, `closeWhenDone` is false.

Envelope handling must be exact:

- Preferred: the child extension handles the `input` event, validates the envelope, stores active request state, and transforms the prompt to remove the envelope before model context.
- If prompt transformation is not available or proves unreliable, do not silently leak the envelope into normal prompts; instead add an explicit worker command or RPC-style helper to inject request metadata outside model-visible text.

### Result file

```ts
interface WorkerResultFile {
  id: string;
  kind: "call" | "coding-agent" | "minitask";
  result: string;
  retrospective?: string;
  isError?: boolean;
  sessionFile?: string;
  timestamp: string;
  contextUsage?: WorkerContextUsage;
}

interface WorkerContextUsage {
  tokens: number | null;
  contextWindow: number | null;
  percent: number | null;
}
```

### Status file

```ts
interface WorkerStatusFile {
  name?: string;
  id?: string;
  kind?: "call" | "coding-agent" | "minitask";
  state: "starting" | "idle" | "claiming" | "running" | "retrospective" | "error" | "exited" | "stale" | "closed";
  lockName?: string;
  paneId?: string;
  cwd?: string;
  sessionFile?: string;
  resultPath?: string;
  artifactDir?: string;
  contextUsage?: WorkerContextUsage;
  updatedAt: string;
}
```

The status file lets `coding-agent` know whether a named worker can accept a follow-up task and lets the parent return context percentage after a task completes. `lockName` is optional because the short-term RPC `minitask` backend may not have a tmux lock.

### Registry

`coding-agent` needs a stable name registry, not only ad hoc `/tmp` status files.

Maintain a registry under a pi-ant state directory, for example:

```text
/tmp/pi-ant-workers/registry.json
/tmp/pi-ant-workers/<safe-name>/status.json
```

Each registry entry should include:

```ts
interface CodingAgentRegistryEntry {
  name: string;
  cwd: string;
  piArgs: string[];
  lockName: string;
  paneId?: string;
  sessionFile: string;
  artifactRoot: string;
  nonce: string;
  statusPath: string;
  createdAt: string;
  updatedAt: string;
}
```

Also append worker metadata to the worker session as custom entries for audit/recovery, but do not rely on session custom entries alone for discovery because they require already knowing the session file.

### Atomic files and claims

All worker-frame file operations should be safe in `/tmp` and under concurrency:

- Create artifact directories with mode `0700`.
- Refuse symlink paths and validate that result/status paths remain inside the artifact root.
- Write result files through a temp file plus atomic link/rename and refuse overwrites.
- Write status files through atomic rename.
- Validate expected request ID when reading result files.
- Use an atomic claim file or lock for `coding-agent` reuse so two parent sessions cannot both observe `idle` and send concurrent tasks.

## Retrospective Semantics

Use `retrospective` everywhere.

When enabled:

1. The main answer is captured first.
2. Only if the main answer succeeded, the child enters a retrospective phase.
3. The retrospective phase runs with tools disabled where the backend supports it.
4. The retrospective prompt asks for only substantial long-term observations, missed caveats, design/naming issues, or cleanup opportunities.
5. If nothing substantial exists, the child must return exactly `everything was ok`.
6. The parent-facing result appends the retrospective under a clear separator.
7. The worker restores the prior tool set after retrospective before accepting follow-up work.

Suggested appended shape:

```md
<main result>

---

Retrospective:
<retrospective text>
```

For `call`, this replaces or reuses the existing `retrospective` behavior.
For `coding-agent`, the worker remains alive after the retrospective completes. The retrospective remains in that worker's conversation history; this is acceptable initially because it can improve follow-up continuity, but if it proves noisy the later design should move retrospective into a branch or hidden custom entry.
For `minitask`, the process exits/disposes after retrospective completes.

## Retry, Timeout, and Websocket Error Handling

Do not infer task completion from semaphore release, lock idleness, or tmux pane output.

The observed failure mode was a transient websocket/provider error like `(1/3)` causing the current `call` path to think the worker was done. The new rule should be:

- A structured subagent task is complete only when the expected `result.json` exists and has the matching request ID.
- Retryable provider errors must not write a result file.
- If the child is auto-retrying, the parent continues waiting.
- If the pane exits before writing a result, only then report a worker failure with captured tmux output.
- If the child is idle but no result exists, treat that as suspicious and continue polling for a quiet period before surfacing a diagnostic, not as success.
- Parent tool cancellation should stop waiting. It should not kill a persistent `coding-agent` unless the user explicitly asks; for `call` and ephemeral `minitask`, cancellation may kill/close the worker.
- Timeout should be optional and default to no timeout for long work. A timeout returns a clear diagnostic with worker/session/artifact paths.

This is more important than fast failure. A hung worker with visible progress is better than a false successful completion.

Longer-term pi core improvement: expose retry lifecycle events to extensions. Today interactive mode receives `auto_retry_start` / `auto_retry_end` internally, but extension events do not appear to expose them directly. If core exposes these, the worker-frame can make retry handling exact instead of heuristic.

## Error Propagation

Use consistent parent behavior:

- Worker writes `isError: true` only for a completed, non-retryable worker failure.
- Parent throws when `isError: true` for `call`, preserving current tool-error behavior.
- Parent may either throw or return an error-shaped result for `coding-agent`; initial proposal: throw for request failure, but include worker metadata in `details` so the user can inspect or continue the worker manually.
- Provider retry in progress is not an error result.
- Retrospective failure should not fail a successful main task. Return the main result plus `retrospective unavailable: <reason>`.

## Context Usage

Context usage should come from `ctx.getContextUsage()` in the worker after the main result and again after retrospective if retrospective runs.

Return the latest available usage:

- For `coding-agent`, this usually means after retrospective, because that is the context the persistent worker will carry into follow-up tasks.
- `tokens`, `contextWindow`, and `percent` are nullable because pi may not know exact usage immediately after compaction or before a provider response.

The old `contextAlertPercent` use case should be replaced by returned context metadata plus future lifecycle commands. A later enhancement can add proactive alerts back on top of the structured status file.

## Tmux Support Changes

Keep these tools:

- `tmux-bash`
- `tmux-capture`
- `tmux-send`
- `tmux-kill`
- `tmux-fork` if still useful as a manual fork primitive

Remove or replace as public tools:

- `tmux-coding-agent` should be replaced by `coding-agent`.

`bin/pi-tmux` can keep lower-level commands internally, but public tool descriptions and guidance should stop recommending the old async coding-agent loop.

Choose a concrete transport before implementation:

- Reuse `session-agent` for starting panes.
- Add a dedicated helper such as `pi-tmux worker-send <name> <prompt-file>` for sending request prompt files safely to an existing persistent worker.
- Avoid raw multiline `tmux-send` as the primary structured request path.

## Implementation Plan

### Phase 1: Add shared types and utilities

Create `extensions/worker-frame.ts` with:

- `makeWorkerId()`
- `createWorkerArtifacts(kind, id)`
- `writeWorkerResult()`
- `parseWorkerResult()`
- `writeWorkerStatus()`
- `readWorkerStatus()`
- `claimCodingAgent(name)` / `releaseCodingAgentClaim(name)`
- `formatResultWithRetrospective()`
- `isRetryableAssistantFailure()` shared with semaphore/call logic

Move reusable artifact/result pieces out of `extensions/call.ts` rather than duplicating them.

### Phase 2: Child-side request handling

Add a worker-frame extension hook that runs in trusted worker instances:

- On `input`, detect and validate `<pi-ant-worker-request>`.
- Reject requests unless trusted env var, nonce, and artifact-root validation pass.
- Store active request state in an append-only custom entry and in process memory.
- Transform the prompt to remove the envelope and leave the task text.
- On `agent_end`, if active request exists:
  - If stop with assistant text: capture main result.
  - If `retrospective: true`: append pending state, disable tools, send retrospective follow-up.
  - If retrospective is complete: write final result and status idle.
  - If non-retryable error: write error result.
  - If retryable error: do not write result.
- On `turn_end`, update context usage in status.
- If `closeWhenDone`: call `ctx.shutdown()` after result write.
- If persistent: restore tools and mark status idle after result write.

This should subsume most child-specific logic currently embedded in `call.ts`.

### Phase 3: Rework `call`

Keep the public schema and prompt guidance.

Change internals to:

- fork parent session as today
- start `session-agent` as today, with worker-frame trust env/metadata
- submit the worker-frame request with `closeWhenDone: true`
- wait for matching result file
- return result

Remove call-specific duplicate retrospective/status/result code after worker-frame handles it.

### Phase 4: Implement `coding-agent`

Add a new focused file:

```text
extensions/coding-agent.ts
```

Register it in `package.json` and remove/deprecate the old `tmux-coding-agent` tool registration.

Behavior details:

- Validate `name` with the same conservative tmux name rules used by `tmux-fork`.
- Resolve `folder` relative to `ctx.cwd`.
- For first use:
  - create a fresh `SessionManager.create(targetCwd)` session
  - append worker metadata custom entry
  - flush session file
  - start `pi-tmux session-agent` with the session file and worker-frame trust env/metadata
  - write registry and status entries
- For reuse:
  - look up registry by `name`
  - reject if requested `folder` or `piArgs` differ from registry
  - ensure pane/lock still exists
  - ensure status is idle
  - atomically claim the worker
  - send a new worker-frame request through the safe prompt-file transport
- Wait for the result file.
- Release the worker claim.
- Return result plus worker metadata and context usage.

Do not rely on `semaphore_wait` for completion. It can still be used internally for pane-exit detection or not at all.

### Phase 5: Add `minitask.retrospective`

Short-term:

- Keep RPC implementation.
- Add optional `retrospective` boolean.
- After main answer succeeds, send a second prompt in the same mini RPC process with tools disabled if RPC supports tool control; if not, use prompt text strongly instructing no tools and document the limitation.
- Append retrospective to the formatted result.

Long-term:

- Port `minitask` to worker-frame with a fresh ephemeral session and `closeWhenDone: true`.
- Keep `simple` model fallback behavior if still useful.

### Phase 6: Lifecycle commands and cleanup

Persistent workers need basic lifecycle support:

- `/coding-agent-list` or a `coding-agent` status mode to list known workers.
- `/coding-agent-kill <name>` to terminate and remove registry/status.
- `/coding-agent-reset <name>` to replace a worker with a fresh session.
- stale cleanup when registry points to a dead pane or missing session.
- high-context diagnostics in the returned result, with reset recommended when context is too high.

These can be added after the main `coding-agent` tool but should be part of the initial design.

### Phase 7: Documentation and guidance

Update:

- `README.md`
- `HOWTO-CALL-MODE.md`
- tool descriptions in `extensions/call.ts`, `extensions/tmux.ts`, and new `extensions/coding-agent.ts`
- generated or declared tool docs/types, if any

Guidance should say:

- Use `call` for current-context delegated work.
- Use `coding-agent` for fresh-context persistent named workers and follow-up tasks.
- Use `minitask` for small one-shot isolated checks/reviews.
- Use `retrospective: true` for broad/deep work, multi-file review, design/naming concerns, or when a second-pass critique is valuable.

### Phase 8: Verification

Add focused checks or manual test scripts for:

- transient retry/websocket error does not complete early
- duplicate result write is refused
- busy `coding-agent` rejects a concurrent task
- two parent sessions cannot race the same named worker claim
- stale worker is diagnosed and recoverable
- retrospective restores tools for persistent workers
- retrospective failure preserves successful main result
- reuse with different `folder` or `piArgs` rejects clearly
- prompt envelope spoofing is rejected without trusted env/nonce

## Open Design Choices

1. Whether `minitask` should be ported immediately.
   - Proposal: add `retrospective` to RPC first, then port only after `call` and `coding-agent` share worker-frame successfully.
2. Whether persistent `coding-agent` retrospective should remain in normal conversation history.
   - Proposal: accept this initially; revisit only if follow-up quality suffers.
3. Whether `coding-agent` should ever support nested `call`.
   - Proposal: strip `call` initially and add an explicit option later only if a real use case appears.

## Non-goals

- Preserve old `tmux-coding-agent` public behavior.
- Keep async completion as the primary coding-agent mode.
- Infer success from locks, pane idleness, or terminal output.
- Add a separate `reflect` option.
