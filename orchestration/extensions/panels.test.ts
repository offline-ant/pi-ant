import assert from "node:assert/strict";
import test, { after, before, type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type { HostTarget } from "../host-types.ts";
import { claimName, readTarget, removeTarget, saveTarget } from "../workers.ts";
import panelsExtension from "./panels.ts";

interface Params {
  name: string;
  command?: string;
  folder?: string;
  lines?: number;
  text?: string;
  keys?: string[];
}
interface Result { content: Array<{ type: string; text: string }>; details: { target: HostTarget } }
type Execute = (id: string, params: Params, signal: AbortSignal | undefined, update: undefined, ctx: ExtensionContext) => Promise<Result>;
interface RegisteredTool {
  name: string;
  renderCall(args: Partial<Params>): Component;
  execute: Execute;
}
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
  const tools = new Map<string, RegisteredTool>();
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
    registerTool: (tool: RegisteredTool) => tools.set(tool.name, tool),
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
          // Only pane queries fail when a pane vanishes; the server itself stays usable.
          if (args.at(-1) === "#{session_id}") { stdout = "$1"; break; }
          stdout = config.dead ? "1" : "0";
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
    run: (tool: string, params: Partial<Params> = {}, signal?: AbortSignal) => tools.get(tool)!.execute("call", { name, ...params }, signal, undefined, ctx),
    list: () => commands.get("panels")!("", ctx),
  };
}

test("collapsed panel tool calls show streaming and completed arguments", (t) => {
  const f = fixture(t);
  const render = (tool: string, args: Partial<Params>): string[] =>
    f.tools.get(tool)!.renderCall(args).render(100).map((line) => line.trimEnd());

  assert.deepEqual(render("panel-start", {}), ["panel-start(", ")"]);
  assert.deepEqual(render("panel-start", { name: f.name }), [
    "panel-start(", `  name: ${f.name}`, ")",
  ]);
  assert.deepEqual(render("panel-start", {
    name: f.name, command: "printf ready\nprintf done", folder: "/tmp/work folder",
  }), [
    "panel-start(",
    `  name: ${f.name}`,
    "  command:",
    "    printf ready",
    "    printf done",
    "  folder: /tmp/work folder",
    ")",
  ]);
  assert.deepEqual(render("panel-read", { name: f.name, lines: 75 }), [
    "panel-read(", `  name: ${f.name}`, "  lines: 75", ")",
  ]);
  assert.deepEqual(render("panel-send", { name: f.name, text: "status" }), [
    "panel-send(", `  name: ${f.name}`, "  text: status", ")",
  ]);
  assert.deepEqual(render("panel-send", { name: f.name, keys: ["ctrl+c", "Escape"] }), [
    "panel-send(", `  name: ${f.name}`, '  keys: ["ctrl+c","Escape"]', ")",
  ]);
  assert.deepEqual(render("panel-close", { name: f.name }), [
    "panel-close(", `  name: ${f.name}`, ")",
  ]);
});

test("neutral tools start shell panels with explicit parent and retain exited names until close", async (t) => {
  const f = fixture(t);
  assert.deepEqual([...f.tools.keys()], ["panel-start", "panel-read", "panel-send", "panel-close"]);
  assert.deepEqual([...f.commands.keys()], ["panels"]);
  const started = await f.run("panel-start", { command: "printf ready", folder: "." });
  assert.equal(started.details.target.kind, "shell");
  assert.match(started.content[0].text, new RegExp(`^Started: ${f.name} \\[tmux\\] in /`));
  assert.equal(readTarget(f.name)?.id, "%9");
  assert.ok(f.calls[0].includes("%1"));
  assert.ok(f.calls[1].includes("$1"));
  f.config.dead = true;
  f.config.output = "finished output";
  assert.match((await f.run("panel-read")).content[0].text, /finished output/);
  await assert.rejects(f.run("panel-start", { command: "other" }), /Close it explicitly/);
  await f.list();
  assert.ok(f.notifications[0].includes(`${f.name} [tmux] shell (%9)`));
  await f.run("panel-close");
  assert.equal(readTarget(f.name), undefined);
  claimName(f.name)();
  assert.ok(f.calls.at(-1)?.includes("kill-pane"));
});

test("vanished native surfaces report clearly and release their name to the next start", async (t) => {
  const f = fixture(t);
  await f.run("panel-start", { command: "server" });
  f.config.missing = true;
  f.config.failRead = true;
  await assert.rejects(f.run("panel-read"), new RegExp(`Panel '${f.name}' no longer exists on tmux`));
  f.config.failRead = false;
  const restarted = await f.run("panel-start", { command: "server" });
  assert.match(restarted.content[0].text, /^Started:/);
  assert.equal(readTarget(f.name)?.id, "%9");
  assert.equal(f.calls.some((args) => args.includes("kill-pane")), false, "a vanished panel needs no native close");
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

test("missing folders, startup failures and name conflicts release their claims", async (t) => {
  const f = fixture(t);
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

test("send submits literal lines or keys, validates combinations, and answers with the resulting output", async (t) => {
  const f = fixture(t);
  await f.run("panel-start", { command: "server" });
  const release = claimName(f.name); // An active parent request owns the name, but human input is still allowed.
  try {
    f.config.output = "prompt> Enter ctrl+c";
    const typed = await f.run("panel-send", { text: "Enter ctrl+c" });
    assert.deepEqual(f.calls.at(-3)?.slice(2), ["send-keys", "-t", "%9", "-l", "--", "Enter ctrl+c"]);
    assert.deepEqual(f.calls.at(-2)?.slice(2), ["send-keys", "-t", "%9", "Enter"]);
    assert.deepEqual(f.calls.at(-1)?.slice(2), ["capture-pane", "-p", "-t", "%9", "-S", "-500"]);
    assert.match(typed.content[0].text, /prompt> Enter ctrl\+c/);
    await f.run("panel-send", { keys: ["ctrl+c", "Escape"] });
    assert.deepEqual(f.calls.at(-2)?.slice(2), ["send-keys", "-t", "%9", "C-c", "Escape"]);
    await assert.rejects(f.run("panel-close"), /already being used/);
  } finally { release(); }
  await assert.rejects(f.run("panel-send"), /exactly one/);
  await assert.rejects(f.run("panel-send", { text: "x", keys: ["Enter"] }), /exactly one/);
  await assert.rejects(f.run("panel-read", { name: "%9" }), /Name must/);
  await assert.rejects(f.run("panel-read", { name: `${f.name}-unknown` }), /No panel named/);
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

test("live read failures keep their native cause and cancelled reads never close existing panels", async (t) => {
  const f = fixture(t);
  await f.run("panel-start", { command: "server" });
  f.config.failRead = true;
  await assert.rejects(f.run("panel-read"), /fake native failure/);
  assert.ok(readTarget(f.name));
  f.config.failRead = false;
  const abort = new AbortController();
  abort.abort();
  const count = f.calls.length;
  await assert.rejects(f.run("panel-read", {}, abort.signal), /abort/i);
  assert.equal(f.calls.length, count);
  assert.ok(readTarget(f.name));
});
