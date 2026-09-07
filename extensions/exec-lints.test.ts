import assert from "node:assert/strict";
import test from "node:test";
import execLints from "./exec-lints.ts";

test("execution lints inspect neutral panel commands and text, not keys", async () => {
  const handlers = new Map<string, (event: unknown) => Promise<{ block?: boolean } | undefined>>();
  execLints({
    on: (name: string, handler: (event: unknown) => Promise<{ block?: boolean } | undefined>) => handlers.set(name, handler),
    registerCommand: () => undefined,
  } as unknown as Parameters<typeof execLints>[0]);
  const handle = handlers.get("tool_call")!;
  assert.equal((await handle({ toolName: "panel-start", input: { name: "test", command: "git restore src" } }))?.block, true);
  assert.equal((await handle({ toolName: "panel-send", input: { target: "test", text: "git restore src" } }))?.block, true);
  assert.equal(await handle({ toolName: "panel-send", input: { target: "test", keys: ["ctrl+c"] } }), undefined);
  const input = { name: "test", command: "npm run check | tail -10" };
  await handle({ toolName: "panel-start", input });
  assert.equal(input.command, "npm run check");
});
