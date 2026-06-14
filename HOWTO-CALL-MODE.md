# Bob's mode HOWTO

Bob's mode tries Bob's `call()`/`return()` shape inside pi.

The root conversation should not do operational tool work directly. It calls
`call({ task })`; the call frame runs on a side branch with normal tools enabled
and must finish by calling `return({ result: "..." })`. Pi then directly
navigates back to the call site and inserts only that result text there. The
tool-heavy call branch stays in the session tree for inspection, but it is not on
the resumed root branch.

## Tools

### `call`

```json
{ "task": "..." }
```

Starts a call frame using the current conversation context. `call` is available in
normal mode and in Bob's mode. It should be the only tool call in its assistant
turn; the call frame does operational work after pi enters it.

### `return`

```json
{
  "result": "Exact text to return to the call site"
}
```

Returns from the active call frame. The call frame should call `return` exactly once
as its final action. The `result` string is inserted directly at the call site.
Return is completed by a post-agent session action, not by a slash-command bridge.

## Commands

```text
/bobs-mode          # toggle on/off
/bobs-mode toggle
/bobs-mode on
/bobs-mode off
/bobs-mode status
/return-now "message" # force-return from the active call frame with message as the result
```

When Bob's mode is on, root active tools are restricted to `call`. The root is
an orchestration thread, not a work thread: default to `call` for tasks,
continuation, status checks, recommendations, and questions whose answers are not
already fully available from compact root context. In particular, do not offer
generic next-step options when current project/session state is unknown; call a
frame to inspect and return a compact recommendation. Answer directly only for
purely conversational/conceptual questions or when recent compact call results
already contain the needed facts.

Inside a call frame, pi restores the tools that were active before Bob's mode was
enabled, adds `return`, and removes `call` to avoid recursion.

`/return-now "message"` is a manual recovery command. It aborts/waits for the
current frame if needed, navigates back to the call site, and inserts the message
as a successful call result.

## Ugo guidance

Ugo guidance should prefer call-based progress prompts for implementation,
enrichment, continuation, and broad distillation work. If a call frame writes or
materially changes a plan, that same plan-writing frame should ask `minitask` for
a generic plan review, triage the suggestions, move executable work to `ready`,
and move real unresolved questions to `needs-decision`. Keep standalone
`minitask` for independent fresh-context review or small isolated questions.
