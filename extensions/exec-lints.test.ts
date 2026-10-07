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

test("sleeping to wait is blocked in favor of the wait tool, short pauses and remote or panel commands are not", async () => {
  const handlers = new Map<string, (event: unknown) => Promise<{ block?: boolean; reason?: string } | undefined>>();
  execLints({
    on: (name: string, handler: (event: unknown) => Promise<{ block?: boolean } | undefined>) => handlers.set(name, handler),
    registerCommand: () => undefined,
  } as unknown as Parameters<typeof execLints>[0]);
  const handle = handlers.get("tool_call")!;
  const bash = (command: string) => handle({ toolName: "bash", input: { command } });
  for (const command of [
    "sleep 600; awk '/^(pass|FAIL)/' /tmp/mac-baseline.log; tail -2 /tmp/mac-baseline.log",
    "sleep 5m",
    "cd x && /bin/sleep 2 && cat log",
    "sleep $DELAY",
    "while ! curl -s localhost:8080; do sleep 1; done",
    "until test -f done; do sleep 0.5; done",
    "for i in 1 2 3; do sleep 1; cat log; done",
  ]) {
    const result = await bash(command);
    assert.equal(result?.block, true, command);
    assert.match(result!.reason!, /Use the `wait` tool/);
  }
  assert.equal((await handle({ toolName: "panel-send", input: { name: "p", text: "sleep 60" } }))?.block, true);
  for (const command of [
    "sleep 1; echo ok",
    "sleep 0.2",
    "ssh flip 'sleep 30; uptime'",
    "for f in *.ts; do echo $f; done; sleep 1",
    "echo sleep 600",
  ]) {
    assert.equal(await bash(command), undefined, command);
  }
  assert.equal(await handle({ toolName: "panel-start", input: { name: "p", command: "while true; do date; sleep 60; done" } }), undefined);
});
