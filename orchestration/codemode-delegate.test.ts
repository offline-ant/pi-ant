import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createCodemodeDelegateController } from "./codemode-delegate.ts";

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-codemode-delegate-test-"));
  const agentDir = path.join(root, "agent");
  const file = path.join(agentDir, "codemode-delegate.json");
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const notifications: Array<{ text: string; level: string }> = [];
  const messages: unknown[] = [];
  const ctx = {
    hasUI: true,
    ui: { notify: (text: string, level: string) => notifications.push({ text, level }) },
  } as unknown as ExtensionCommandContext;
  function create() {
    let command: { handler(args: string, ctx: ExtensionCommandContext): Promise<void> } | undefined;
    const changes: boolean[] = [];
    const events = new Map<string, (event: unknown, ctx: ExtensionCommandContext) => Promise<void>>();
    const pi = {
      registerCommand: (name: string, spec: typeof command) => {
        assert.equal(name, "codemode-delegate");
        command = spec;
      },
      on: (name: string, handler: (event: unknown, ctx: ExtensionCommandContext) => Promise<void>) => events.set(name, handler),
      sendMessage: (message: unknown) => messages.push(message),
    } as unknown as ExtensionAPI;
    const controller = createCodemodeDelegateController(pi, (enabled) => changes.push(enabled));
    assert.ok(command);
    return {
      controller, changes,
      run: (args: string) => command!.handler(args, ctx),
      emit: (event: string) => events.get(event)!({}, ctx),
    };
  }
  return { agentDir, file, ctx, notifications, messages, create };
}

test("default off creates no file; toggle/on/off/status persist privately and report in UI and print modes", async (t) => {
  const f = fixture(t);
  const c = f.create();
  await c.emit("session_start");
  await c.run("status");
  await c.run("off");
  assert.deepEqual(c.changes, []);
  assert.equal(fs.existsSync(f.agentDir), false);
  assert.match(f.notifications.at(-1)!.text, /disabled globally.*model-only/);
  await c.run("");
  assert.deepEqual(c.changes, [true]);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file, "utf8")), { enabled: true });
  assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(f.agentDir).mode & 0o777, 0o700);
  assert.deepEqual(fs.readdirSync(f.agentDir), ["codemode-delegate.json"]);
  await c.run("on");
  await c.run("status");
  assert.deepEqual(c.changes, [true], "unchanged choices do not re-register");
  assert.match(f.notifications.at(-1)!.text, /enabled globally/);
  await assert.rejects(c.run("enabled"), /Usage/);
  assert.equal(c.controller.refresh(f.ctx), true);
  f.ctx.hasUI = false;
  await c.run("");
  assert.deepEqual(c.changes, [true, false]);
  assert.equal(fs.existsSync(f.file), false);
  assert.match(JSON.stringify(f.messages), /codemode-delegate-status.*disabled globally/);
});

test("new sessions and submitted prompts observe global state; malformed config fails closed and can be repaired", async (t) => {
  const f = fixture(t);
  const first = f.create();
  await first.run("on");
  const second = f.create();
  await second.emit("session_start");
  assert.deepEqual(second.changes, [true]);
  await first.run("off");
  await second.emit("input");
  assert.deepEqual(second.changes, [true, false]);
  for (const value of ["not json", "null", "{}", '{"enabled":"true"}', '{"enabled":false}']) {
    await first.run("on");
    assert.equal(second.controller.refresh(f.ctx), true);
    fs.writeFileSync(f.file, value);
    assert.equal(second.controller.refresh(f.ctx), false);
    const count = f.notifications.length;
    assert.equal(second.controller.refresh(f.ctx), false);
    assert.equal(f.notifications.length, count, "duplicate diagnostics are suppressed");
    assert.equal(f.notifications.at(-1)!.level, "error");
    assert.match(f.notifications.at(-1)!.text, /invalid configuration/);
  }
  await first.run("off");
  assert.equal(fs.existsSync(f.file), false);
  assert.equal(second.controller.refresh(f.ctx), false);
});
