# Bob's mode HOWTO

Bob's mode tries Bob's `call()` shape inside pi.

The root conversation should not do operational tool work directly. It calls
`call({ task })`; the call frame runs in a forked pi session in a new tmux pane
with normal tools enabled. The worker's final assistant message is saved as the
result for the parent. The parent `call` tool waits for that result and returns
it as normal tool-result content, so the root agent continues from the compact
returned text.

The tool-heavy worker branch stays in its forked session and tmux pane for
inspection. It is not merged into the root session tree.

## Tools

### `call`

```json
{
  "task": "...",
  "complex": false
}
```

Starts a tmux-backed call frame using the current conversation context before the
parent assistant's unresolved `call` tool call. `call` is available in normal mode
and in Bob's mode. It should be the only tool call in its assistant turn because
sibling tool work is not included in the forked worker context. The parent blocks
until the worker returns, exits early, or is aborted.

Set `complex: true` only when the worker may need nested `call` frames for
substantial subtasks. Calls wait indefinitely by design. If `/tool-model` is set,
call frames start with that configured pi model/thinking level.

A call frame finishes when it returns a final assistant message. That message is
written for the parent, and the worker pi process shuts down gracefully. The call
artifact directory contains `prompt.md`, `result.json`, and `result.md`; calls
with `retrospective: true` also write `reflect.md`.

## Commands

```text
/bobs-mode          # toggle on/off
/bobs-mode toggle
/bobs-mode on
/bobs-mode off
/bobs-mode status
/finish-call-now "message" # child-frame recovery: override result with message and shut down
```

When Bob's mode is on, root active tools are restricted to `call` and `ask`. The root is
an orchestration thread, not a work thread: default to `call` for tasks,
continuation, status checks, recommendations, and questions whose answers are not
already fully available from compact root context. In particular, do not offer
generic next-step options when current project/session state is unknown; call a
frame to inspect and return a compact recommendation. Answer directly only for
purely conversational/conceptual questions or when recent compact call results
already contain the needed facts.

Inside a call frame, pi restores the worker tools captured by the parent and adds
`call` only for complex frames. Call frames compact like normal pi sessions; the
delegated task is injected on every turn so compaction does not remove the
worker's objective.

`/finish-call-now "message"` is a manual recovery command for a child tmux call frame.
It aborts/waits for the current worker if needed, overrides the call result with
`message`, and requests worker shutdown. Outside a tmux call frame it only warns.

## Ugo guidance

Ugo guidance should prefer call-based progress prompts for implementation,
enrichment, continuation, and broad distillation work. If a call frame writes or
materially changes a plan, that same plan-writing frame should ask `minitask` for
a generic plan review, triage the suggestions, move executable work to `ready`,
and move real unresolved questions to `needs-decision`. Keep standalone
`minitask` for independent fresh-context review or small isolated questions.
