import assert from "node:assert/strict";
import test from "node:test";
import execLints from "./exec-lints.ts";

type Result = { block?: boolean; reason?: string } | undefined;
type Handler = (event: unknown) => Promise<Result>;

function lints(): { handle: Handler; newTurn: () => Promise<unknown> } {
  const handlers = new Map<string, Handler>();
  execLints({
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    registerCommand: () => undefined,
  } as unknown as Parameters<typeof execLints>[0]);
  return { handle: handlers.get("tool_call")!, newTurn: () => handlers.get("turn_start")!({}) };
}

test("execution lints inspect neutral panel commands and text, not keys", async () => {
  const { handle } = lints();
  assert.equal((await handle({ toolName: "panel-start", input: { name: "test", command: "git restore src" } }))?.block, true);
  assert.equal((await handle({ toolName: "panel-send", input: { name: "test", text: "git restore src" } }))?.block, true);
  assert.equal(await handle({ toolName: "panel-send", input: { name: "test", keys: ["ctrl+c"] } }), undefined);
});

test("a trailing pipe tail on build output is blocked once and never rewritten, keeping its redirections in the suggestion", async () => {
  const { handle, newTurn } = lints();
  // The real case: silently stripping `| tail …` also dropped `> s1-big.log`.
  const command = "cd /home/devops/sn/lace && CARGO_TARGET_DIR=/x timeout 600 cargo test -p lace-sans-io --lib foo -- --ignored 2>&1 | tail -15 > /home/devops/sn-build/s1-big.log";
  const input = { name: "big-gen", command };
  const result = await handle({ toolName: "panel-start", input });
  assert.equal(result?.block, true);
  assert.equal(input.command, command);
  assert.equal(/Re-run without the pipe tail: `(.*)`$/s.exec(result!.reason!)?.[1],
    "cd /home/devops/sn/lace && CARGO_TARGET_DIR=/x timeout 600 cargo test -p lace-sans-io --lib foo -- --ignored 2>&1 > /home/devops/sn-build/s1-big.log");
  // A deliberate retry in the same turn passes, whichever tool it uses.
  assert.equal(await handle({ toolName: "bash", input: { command } }), undefined);
  await newTurn();

  const suggestion = async (toolName: string, text: string) => {
    await newTurn();
    const input = toolName === "panel-send" ? { name: "p", text } : { name: "p", command: text };
    const blocked = await handle({ toolName, input });
    return blocked?.block ? /Re-run without the pipe tail: `(.*)`$/s.exec(blocked.reason!)?.[1] : undefined;
  };
  assert.equal(await suggestion("bash", "npm run check | tail -10"), "npm run check");
  assert.equal(await suggestion("panel-send", "cargo build --release 2>&1 | grep -v warn | tail -n 20 2>/dev/null"), "cargo build --release 2>&1 | grep -v warn 2>/dev/null");
  assert.equal(await suggestion("bash", "(make check | tail -5)"), "(make check )");
  assert.equal(await suggestion("bash", "./build.sh &>log.txt | tail -3 >>'out file'"), "./build.sh &>log.txt >>'out file'");
  assert.equal(await suggestion("bash", "npm run build:prod | tail -3"), "npm run build:prod");
  for (const command of [
    // Only the pipeline feeding tail counts, not paths or earlier commands.
    "cd build && ls | tail -3",
    "cat /home/devops/sn-build/build.log | tail -20",
    "cargo check; git log --oneline | tail -5",
    "ssh flip 'cargo build' | tail -5",
    "cargo build | tail -5; echo done",
  ]) {
    assert.equal(await suggestion("bash", command), undefined, command);
  }
});

test("sleeping to wait is blocked in favor of the wait tool, short pauses and remote or panel commands are not", async () => {
  const { handle } = lints();
  const bash = (command: string) => handle({ toolName: "bash", input: { command } });
  for (const command of [
    "sleep 600; awk '/^(pass|FAIL)/' /tmp/mac-baseline.log; tail -2 /tmp/mac-baseline.log",
    "sleep 5m",
    "cd x && /bin/sleep 2 && cat log",
    "sleep $DELAY",
    "while ! curl -s localhost:8080; do sleep 1; done",
    "until test -f done; do sleep 0.5; done",
    "for i in 1 2 3; do sleep 1; cat log; done",
    // Local shell scripts are checked like the command itself.
    "timeout 300 bash -c 'while [ ! -s /tmp/x ]; do sleep 5; done'; cat /tmp/x",
    "env FOO=1 nice -n 5 sh -ec 'sleep 30'",
    "/bin/bash -lc \"bash -c 'sleep 10'\"",
    "while true; do bash -c 'sleep 1'; done",
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
    "ssh host 'while true; do sleep 5; done'",
    "bash -c 'sleep 1; echo ok'",
    "bash script.sh sleep 600",
    "ssh host bash -c 'sleep 30'",
  ]) {
    assert.equal(await bash(command), undefined, command);
  }
  assert.equal(await handle({ toolName: "panel-start", input: { name: "p", command: "while true; do date; sleep 60; done" } }), undefined);
});
