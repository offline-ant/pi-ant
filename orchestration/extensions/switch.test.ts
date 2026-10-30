import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import { createEventBus, SessionManager, type ExtensionAPI, type ExtensionCommandContext, type RegisteredCommand } from "@earendil-works/pi-coding-agent";
import { flushSessionFile } from "../context.ts";
import workerFrame, { createWorkerArtifacts, readWorkerStatus, writeWorkerRequest } from "../worker-frame.ts";
import { registerSwitch } from "./switch.ts";

function fixture(t: TestContext, options: { host?: string; mode?: "tui" | "rpc" } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-switch-command-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const session = SessionManager.create(directory, directory);
  session.appendCustomEntry("fixture", {});
  flushSessionFile(session, session.getSessionFile()!);
  const commands = new Map<string, RegisteredCommand>();
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const messages: string[] = [];
  const events = createEventBus();
  let idle = true;
  let pending = false;
  let prepares = 0;
  let replacements = 0;
  let prepare = async () => {};
  const pi = {
    events,
    on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => { handlers.set(name, handler); },
    registerCommand: (name: string, command: RegisteredCommand) => { commands.set(name, command); },
    getActiveTools: () => ["read"], getAllTools: () => [{ name: "read" }], getThinkingLevel: () => "high",
    appendEntry: (type: string, data: unknown) => session.appendCustomEntry(type, data),
    sendUserMessage: () => {}, setModel: async () => true, setThinkingLevel: () => {}, setActiveTools: () => {},
  } as unknown as ExtensionAPI;
  const ctx = {
    mode: options.mode ?? "rpc", cwd: directory, sessionManager: session, model: { provider: "fixture", id: "test" },
    isIdle: () => idle, hasPendingMessages: () => pending,
    switchSession: async (file: string) => {
      assert.equal(file, session.getSessionFile());
      replacements++;
      return { cancelled: true };
    },
    waitForIdle: async () => {}, modelRegistry: { find: () => ({ provider: "fixture", id: "test" }) },
    getContextUsage: () => null,
    ui: {
      select: async () => "tau", notify: (text: string) => messages.push(text),
      setStatus: () => {}, setWidget: () => {}, theme: { fg: (_color: string, text: string) => text },
    },
  } as unknown as ExtensionCommandContext;
  registerSwitch(pi, {
    environment: () => ({ HOME: directory, PI_ORCHESTRATION_HOST: options.host ?? "emacs", PI_ORCHESTRATION_TARGET: "ordinary-root" }),
    targets: () => [],
    prepare: async () => { prepares++; await prepare(); return { start: async () => "unused" }; },
  });
  return {
    pi, ctx, session, messages, handlers, commands, events,
    command: (args = "tau") => commands.get("switch")!.handler(args, ctx),
    busy: () => { idle = false; }, queued: () => { pending = true; },
    setPrepare: (fn: typeof prepare) => { prepare = fn; },
    counts: () => ({ prepares, replacements }),
  };
}

for (const mode of ["busy", "queued", "unpersisted", "invalid", "ugo"] as const) {
  test(`${mode} source is refused before any destination action`, async (t) => {
    const f = fixture(t);
    if (mode === "busy") f.busy();
    if (mode === "queued") f.queued();
    if (mode === "ugo") f.session.appendCustomEntry("pi-ant:ugo-state", { active: true });
    if (mode === "unpersisted") fs.unlinkSync(f.session.getSessionFile()!);
    await f.command(mode === "invalid" ? "tmux" : "tau");
    assert.deepEqual(f.counts(), { prepares: 0, replacements: 0 });
    assert.ok(f.messages.length > 0);
  });
}

test("ordinary Emacs root identity is not mistaken for a managed worker; no-argument picker works", async (t) => {
  const f = fixture(t);
  await f.command("");
  assert.deepEqual(f.counts(), { prepares: 1, replacements: 1 });
});

test("the picker offers Emacs, and a Pilish source is already in Emacs", async (t) => {
  const f = fixture(t);
  let offered: string[] = [];
  f.ctx.ui.select = (async (_title: string, options: string[]) => { offered = options; return "emacs"; }) as typeof f.ctx.ui.select;
  await f.command("");
  assert.deepEqual(offered, ["herdr", "tau", "emacs"]);
  assert.deepEqual(f.counts(), { prepares: 0, replacements: 0 });
  assert.match(f.messages.at(-1)!, /already in emacs/);
  const tui = fixture(t, { host: "herdr", mode: "tui" });
  await tui.command("emacs");
  assert.deepEqual(tui.counts(), { prepares: 1, replacements: 1 });
});

test("a TUI configured to orchestrate on web still transfers, while a Tau RPC source is already there", async (t) => {
  const tui = fixture(t, { host: "web", mode: "tui" });
  await tui.command();
  assert.deepEqual(tui.counts(), { prepares: 1, replacements: 1 });
  const rpc = fixture(t, { host: "web", mode: "rpc" });
  await rpc.command();
  assert.deepEqual(rpc.counts(), { prepares: 0, replacements: 0 });
  assert.match(rpc.messages.at(-1)!, /already in tau/);
});

for (const mode of ["tui", "rpc"] as const) {
  test(`${mode}: source stays open with a destination notice and native resume reminder`, async (t) => {
    const f = fixture(t, { mode });
    const before = process.rawListeners("exit");
    const widgets: unknown[] = [];
    let shutdowns = 0;
    f.ctx.switchSession = async (file, options) => {
      assert.equal(file, f.session.getSessionFile());
      await options?.withSession?.({
        ...f.ctx, sendMessage: async () => {}, sendUserMessage: async () => {},
        ui: { ...f.ctx.ui, setWidget: (_key, value) => { widgets.push(value); } },
        shutdown: () => { shutdowns++; },
      });
      return { cancelled: false };
    };
    await f.command();
    assert.equal(shutdowns, 0);
    assert.deepEqual(process.rawListeners("exit"), before);
    assert.match(f.messages.at(-1)!, /Session open in unused/);
    assert.match(f.messages.at(-1)!, /does not sync.*\/resume/s);
    assert.equal(widgets.length, mode === "tui" ? 1 : 0);
  });
}

test("a second command is rejected during preflight and new work cancels release", async (t) => {
  const f = fixture(t);
  let finish!: () => void;
  let started!: () => void;
  const waiting = new Promise<void>((resolve) => { finish = resolve; });
  const entered = new Promise<void>((resolve) => { started = resolve; });
  f.setPrepare(async () => { started(); await waiting; });
  const first = f.command();
  await entered;
  await f.command();
  assert.match(f.messages.at(-1)!, /already in progress/);
  f.busy();
  finish();
  await first;
  assert.deepEqual(f.counts(), { prepares: 1, replacements: 0 });
  assert.match(f.messages.at(-1)!, /current turn and queued messages/);
});

test("active worker, including one waiting idle, blocks switching without a registry entry", async (t) => {
  const f = fixture(t);
  workerFrame(f.pi);
  const artifacts = createWorkerArtifacts();
  t.after(() => fs.rmSync(artifacts.artifactDir, { recursive: true, force: true }));
  writeWorkerRequest(artifacts, {
    id: "switch-guard", task: "work", tools: ["read"], model: { provider: "fixture", id: "test" },
    thinkingLevel: "high", resultPath: artifacts.resultPath, statusPath: artifacts.statusPath,
  });
  await f.commands.get("worker-run")!.handler(artifacts.requestPath, f.ctx);
  await f.command();
  assert.deepEqual(f.counts(), { prepares: 0, replacements: 0 });
  assert.match(f.messages.at(-1)!, /managed worker/);
  await f.handlers.get("agent_end")!({ messages: [{ role: "assistant", content: [], stopReason: "aborted" }] }, f.ctx);
  await f.handlers.get("agent_settled")!({}, f.ctx);
  assert.equal(readWorkerStatus(artifacts.statusPath)?.state, "waiting");
  await f.command();
  assert.deepEqual(f.counts(), { prepares: 0, replacements: 0 });
  await f.handlers.get("session_shutdown")!({}, f.ctx);
  const guard = { blocked: false };
  f.events.emit("pi-orchestration:switch-check", guard);
  assert.equal(guard.blocked, false, "shutdown removes the old worker guard");
});
