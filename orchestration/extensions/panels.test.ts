import assert from "node:assert/strict";
import test, { after, before, type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { HostTarget } from "../host-types.ts";
import { claimName, readTarget, removeTarget, saveTarget } from "../workers.ts";
import panelsExtension from "./panels.ts";

interface Params {
  name: string;
  command?: string;
  folder?: string;
  waitFor?: { match: string; regex?: boolean; timeoutMs?: number };
  lines?: number;
  text?: string;
  keys?: string[];
  enter?: boolean;
}
interface Result { content: Array<{ type: string; text: string }>; details: { target: HostTarget } }
type Execute = (id: string, params: Params, signal: AbortSignal | undefined, update: undefined, ctx: ExtensionContext) => Promise<Result>;
const endpoint = `/tmp/panels-fake-${process.pid}`;
const envKeys = ["PI_ORCHESTRATION_HOST", "PI_ORCHESTRATION_ENDPOINT", "TMUX_PANE"];
const previous = envKeys.map((key) => process.env[key]);
before(() => {
  process.env.PI_ORCHESTRATION_HOST = "tmux";
  process.env.PI_ORCHESTRATION_ENDPOINT = endpoint;
  process.env.TMUX_PANE = "%1";
});
after(() => envKeys.forEach((key, index) => {
  if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index];
}));
let next = 0;

function fixture(t: TestContext) {
  const name = `panel-test-${process.pid}-${next++}`;
  const tools = new Map<string, Execute>();
  const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
  const calls: string[][] = [];
  const notifications: string[] = [];
  const config = {
    output: "booting",
    dead: false,
    missing: false,
    failStart: false,
    failClose: false,
    failRead: false,
    onRead: () => {},
    onCreate: () => {},
    onClose: () => {},
  };
  const pi = {
    registerTool: (tool: { name: string; execute: Execute }) => tools.set(tool.name, tool.execute),
    registerCommand: (command: string, spec: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => commands.set(command, spec.handler),
    exec: async (command: string, args: string[]) => {
      assert.equal(command, "tmux");
      assert.deepEqual(args.slice(0, 2), ["-S", endpoint], "operations must retain the registered endpoint");
      calls.push(args);
      let stdout = "";
      let code = 0;
      switch (args[2]) {
        case "new-window": stdout = "%9"; code = config.failStart ? 1 : 0; config.onCreate(); break;
        case "display-message":
          stdout = args.at(-1) === "#{session_id}" ? "$1" : config.dead ? "1" : "0";
          code = config.missing ? 1 : 0;
          break;
        case "capture-pane": stdout = config.output; code = config.failRead ? 1 : 0; config.onRead(); break;
        case "send-keys": break;
        case "kill-pane": code = config.failClose ? 1 : 0; config.onClose(); break;
        default: assert.fail(`Unexpected native operation: ${args.join(" ")}`);
      }
      return { stdout, code, stderr: code ? "fake native failure" : "", killed: false };
    },
  } as unknown as ExtensionAPI;
  const ctx = { cwd: "/tmp", ui: { notify: (text: string) => notifications.push(text) } } as unknown as ExtensionContext;
  panelsExtension(pi);
  t.after(() => removeTarget(name));
  return {
    name, tools, commands, config, calls, notifications,
    run: (tool: string, params: Partial<Params> = {}, signal?: AbortSignal) => tools.get(tool)!("call", { name, ...params }, signal, undefined, ctx),
    list: () => commands.get("panels")!("", ctx),
  };
}

test("neutral tools start shell panels with explicit parent and retain exited names until close", async (t) => {
  const f = fixture(t);
  assert.deepEqual([...f.tools.keys()], ["panel-start", "panel-read", "panel-send", "panel-close"]);
  assert.deepEqual([...f.commands.keys()], ["panels"]);
  const started = await f.run("panel-start", { command: "printf ready", folder: "." });
  assert.equal(started.details.target.kind, "shell");
  assert.equal(readTarget(f.name)?.id, "%9");
  assert.ok(f.calls[0].includes("%1"));
  assert.ok(f.calls[1].includes("$1"));
  f.config.dead = true;
  f.config.output = "finished output";
  assert.match((await f.run("panel-read")).content[0].text, /finished output/);
  await assert.rejects(f.run("panel-start", { command: "other" }), /Close it explicitly/);
  await f.list();
  assert.ok(f.notifications[0].includes(`${f.name} (tmux:%9; endpoint: ${endpoint}) [shell]`));
  await f.run("panel-close");
  assert.equal(readTarget(f.name), undefined);
  claimName(f.name)();
  assert.ok(f.calls.at(-1)?.includes("kill-pane"));
});

test("literal and regex readiness use snapshots and check before treating process exit as failure", async (t) => {
  const f = fixture(t);
  let reads = 0;
  f.config.onRead = () => { reads++; f.config.output = "server listening: 8080"; };
  const ready = await f.run("panel-start", { command: "server", waitFor: { match: "listening: \\d+", regex: true, timeoutMs: 1000 } });
  assert.equal(reads, 2);
  assert.match(ready.content[0].text, /^Ready:/);
  await f.run("panel-close");
  f.config.dead = true;
  const exitedReady = await f.run("panel-start", { command: "echo listening", waitFor: { match: "listening: 8080" } });
  assert.match(exitedReady.content[0].text, /^Ready:/);
});

test("readiness timeout retains identity, recent output, registry and releaseable claim", async (t) => {
  const f = fixture(t);
  await assert.rejects(f.run("panel-start", { command: "sleep 1", waitFor: { match: "ready", timeoutMs: 20 } }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /Readiness timed out after 20ms/);
    assert.ok(error.message.includes(`${f.name} (tmux:%9; endpoint: ${endpoint})`));
    assert.match(error.message, /booting/);
    return true;
  });
  assert.equal(readTarget(f.name)?.id, "%9");
  assert.equal(f.calls.some((args) => args.includes("kill-pane")), false);
  claimName(f.name)();
  await f.run("panel-close");
});

test("process exit and missing target fail readiness without deleting diagnostic registration", async (t) => {
  const f = fixture(t);
  f.config.dead = true;
  await assert.rejects(f.run("panel-start", { command: "false", waitFor: { match: "ready" } }), /Process exited before readiness matched[\s\S]*booting/);
  assert.ok(readTarget(f.name));
  await f.run("panel-close");
  f.config.dead = false;
  f.config.onRead = () => { f.config.missing = true; };
  await assert.rejects(f.run("panel-start", { command: "true", waitFor: { match: "ready" } }), /Process missing/);
  assert.ok(readTarget(f.name));
});

test("cancellation while awaiting readiness closes and unregisters only the newly owned target", async (t) => {
  const f = fixture(t);
  const abort = new AbortController();
  f.config.onRead = () => abort.abort();
  await assert.rejects(f.run("panel-start", { command: "sleep 1", waitFor: { match: "ready" } }, abort.signal), /abort/i);
  assert.equal(readTarget(f.name), undefined);
  assert.equal(f.calls.filter((args) => args.includes("kill-pane")).length, 1);
  claimName(f.name)();
});

test("cancellation during creation and pre-aborted calls do not orphan or touch existing work", async (t) => {
  const f = fixture(t);
  const abort = new AbortController();
  f.config.onCreate = () => abort.abort();
  await assert.rejects(f.run("panel-start", { command: "sleep 1" }, abort.signal), /abort/i);
  assert.equal(readTarget(f.name), undefined);
  assert.equal(f.calls.filter((args) => args.includes("kill-pane")).length, 1);
  const before = f.calls.length;
  await assert.rejects(f.run("panel-start", { command: "sleep 1" }, abort.signal), /abort/i);
  assert.equal(f.calls.length, before);
});

test("invalid readiness, missing folders, startup failures and name conflicts release their claims", async (t) => {
  const f = fixture(t);
  await assert.rejects(f.run("panel-start", { command: "true", waitFor: { match: "[", regex: true } }), /Invalid regular expression/);
  await assert.rejects(f.run("panel-start", { command: "true", folder: `/missing-panel-${process.pid}` }), /folder does not exist/);
  assert.equal(f.calls.length, 0);
  f.config.failStart = true;
  await assert.rejects(f.run("panel-start", { command: "true" }), /fake native failure/);
  assert.equal(readTarget(f.name), undefined);
  claimName(f.name)();
  const release = claimName(f.name);
  try {
    const count = f.calls.length;
    await assert.rejects(f.run("panel-start", { command: "true" }), /already being used/);
    assert.equal(f.calls.length, count);
  } finally { release(); }
  saveTarget({ name: f.name, kind: "pi", host: "tmux", endpoint, id: "%42" });
  await assert.rejects(f.run("panel-start", { command: "true" }), /already exists/);
  assert.equal(readTarget(f.name)?.id, "%42");
});

test("reads are repeatable bounded snapshots and truncate oversized Unicode output", async (t) => {
  const f = fixture(t);
  await f.run("panel-start", { command: "server" });
  f.config.output = "one\ntwo\nthree";
  const first = await f.run("panel-read", { lines: 2 });
  const second = await f.run("panel-read", { lines: 2 });
  assert.deepEqual(first, second);
  assert.match(first.content[0].text, /\ntwo\nthree$/);
  f.config.output = "漢字".repeat(15000);
  const huge = await f.run("panel-read", { lines: 2000 });
  assert.ok(Buffer.byteLength(huge.content[0].text) < 52_000);
  assert.match(huge.content[0].text, /Snapshot truncated/);
  assert.ok(!huge.content[0].text.includes("�"));
  f.config.output = Array.from({ length: 3000 }, (_, index) => `line ${index}`).join("\n");
  const manyLines = await f.run("panel-read", { lines: 2000 });
  assert.equal(manyLines.content[0].text.split("\n").length, 2001); // Identity plus snapshot.
  assert.match(manyLines.content[0].text, /line 2999$/);
});

test("send distinguishes literal text from keys, validates combinations, and allows supervised input", async (t) => {
  const f = fixture(t);
  await f.run("panel-start", { command: "server" });
  const release = claimName(f.name); // An active parent request owns the name, but human input is still allowed.
  try {
    await f.run("panel-send", { text: "Enter ctrl+c\nmore", enter: false });
    assert.deepEqual(f.calls.at(-1)?.slice(2), ["send-keys", "-t", "%9", "-l", "--", "Enter ctrl+c\nmore"]);
    await f.run("panel-send", { text: "" });
    assert.deepEqual(f.calls.at(-1)?.slice(2), ["send-keys", "-t", "%9", "Enter"]);
    await f.run("panel-send", { keys: ["ctrl+c", "Escape"] });
    assert.deepEqual(f.calls.at(-1)?.slice(2), ["send-keys", "-t", "%9", "C-c", "Escape"]);
    await assert.rejects(f.run("panel-close"), /already being used/);
  } finally { release(); }
  await assert.rejects(f.run("panel-send"), /exactly one/);
  await assert.rejects(f.run("panel-send", { text: "x", keys: ["Enter"] }), /exactly one/);
  await assert.rejects(f.run("panel-send", { keys: ["Enter"], enter: false }), /only valid with text/);
  await assert.rejects(f.run("panel-read", { name: "%9" }), /Name must/);
});

test("stored host survives environment changes, close completes despite cancellation and failed close retains recovery", async (t) => {
  const f = fixture(t);
  await f.run("panel-start", { command: "server" });
  const host = process.env.PI_ORCHESTRATION_HOST;
  const savedEndpoint = process.env.PI_ORCHESTRATION_ENDPOINT;
  try {
    process.env.PI_ORCHESTRATION_HOST = "emacs";
    process.env.PI_ORCHESTRATION_ENDPOINT = "/different-server";
    await f.run("panel-read");
    f.config.failClose = true;
    await assert.rejects(f.run("panel-close"), /fake native failure/);
    assert.ok(readTarget(f.name));
    claimName(f.name)();
    f.config.failClose = false;
    const abort = new AbortController();
    f.config.onClose = () => abort.abort();
    await f.run("panel-close", {}, abort.signal);
    assert.equal(readTarget(f.name), undefined);
  } finally {
    process.env.PI_ORCHESTRATION_HOST = host;
    process.env.PI_ORCHESTRATION_ENDPOINT = savedEndpoint;
  }
});

test("read failures preserve diagnostic identity; cancelling a read never closes pre-existing work", async (t) => {
  const f = fixture(t);
  f.config.failRead = true;
  await assert.rejects(f.run("panel-start", { command: "server", waitFor: { match: "ready" } }), /fake native failure[\s\S]*Panel retained:[\s\S]*no output captured/);
  assert.ok(readTarget(f.name));
  f.config.failRead = false;
  const abort = new AbortController();
  abort.abort();
  const count = f.calls.length;
  await assert.rejects(f.run("panel-read", {}, abort.signal), /abort/i);
  assert.equal(f.calls.length, count);
  assert.ok(readTarget(f.name));
});

test("failed cancellation cleanup reports retained target instead of losing recovery identity", async (t) => {
  const f = fixture(t);
  const abort = new AbortController();
  f.config.failClose = true;
  f.config.onRead = () => abort.abort();
  await assert.rejects(f.run("panel-start", { command: "sleep 1", waitFor: { match: "ready" } }, abort.signal), /Could not close .*tmux:%9/);
  assert.ok(readTarget(f.name));
  claimName(f.name)();
});
