import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import terminalInput from "./extensions/terminal-input.ts";
import { terminalRequest } from "./terminal-input.ts";
import { prepareTauSwitch as prepareTauDestination, prepareHerdrSwitch, switchEnvironment, type SwitchSource } from "./switch-destinations.ts";

// Unit tests never open the user's browser; native smoke supplies a PATH fixture.
const prepareTauSwitch = (source: SwitchSource, endpoint: string, open: (url: string) => Promise<void> = async () => {}) => prepareTauDestination(source, endpoint, open);

function source(t: TestContext): SwitchSource {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-switch-transport-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return {
    sessionFile: path.join(directory, "conversation.jsonl"), cwd: directory,
    args: ["--provider", "fixture", "--model", "test", "--thinking", "high"],
    env: switchEnvironment({ HOME: directory, PI_CODING_AGENT_DIR: directory, HERDR_SOCKET_PATH: "/tmp/fixture-herdr.sock" }),
  };
}

async function tau(t: TestContext, handle: http.RequestListener) {
  const server = http.createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address() as net.AddressInfo;
  return `http://private-user:private-password@127.0.0.1:${address.port}`;
}

function json(response: http.ServerResponse, data: unknown, status = 200) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(data));
}

async function body(request: http.IncomingMessage) {
  let text = "";
  for await (const chunk of request) text += String(chunk);
  return JSON.parse(text) as Record<string, unknown>;
}

test("Tau preflight and resume retain state, omit force, and never expose endpoint credentials", async (t) => {
  const session = source(t);
  const requests: string[] = [];
  let input: Record<string, unknown> | undefined;
  const endpoint = await tau(t, async (req, res) => {
    requests.push(`${req.method} ${req.url}`);
    assert.equal(req.headers.authorization, `Basic ${Buffer.from("private-user:private-password").toString("base64")}`);
    if (req.method === "GET") json(res, { sessions: [] });
    else {
      input = await body(req);
      json(res, { session: { id: "destination", sessionFile: session.sessionFile }, started: true });
    }
  });
  const opened: string[] = [];
  const prepared = await prepareTauSwitch(session, endpoint, async (url) => {
    assert.equal(requests.at(-1), "POST /api/live-sessions/resume");
    opened.push(url);
  });
  assert.deepEqual(opened, []);
  assert.deepEqual(requests, ["GET /api/live-sessions"]);
  const location = await prepared.start();
  assert.match(location, /Tau tab destination/);
  assert.equal(opened.length, 1);
  assert.match(opened[0]!, /\/#session=destination$/);
  assert.ok(location.includes(opened[0]!));
  assert.doesNotMatch(location, /private-user|private-password/);
  assert.deepEqual(requests, ["GET /api/live-sessions", "POST /api/live-sessions/resume"]);
  assert.equal(input?.filePath, session.sessionFile);
  assert.equal(input?.cwd, session.cwd);
  assert.deepEqual(input?.args, session.args);
  assert.equal(input?.force, undefined);
  assert.equal(input?.refresh, true);
  const env = input?.env as Record<string, string>;
  assert.equal(env.PI_ORCHESTRATION_HOST, "web");
  assert.equal(env.HERDR_SOCKET_PATH, session.env.HERDR_SOCKET_PATH);
  assert.equal(env.PI_NESTED, "");
  for (const key of ["PI_ORCHESTRATION_CONTROL", "PI_ORCHESTRATION_TARGET", "HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID", "TMUX", "TMUX_PANE"]) assert.equal(env[key], "");
});

test("a long-lived desktop opener does not delay or get killed after a successful handoff", { timeout: 15_000, skip: process.platform === "win32" }, async (t) => {
  const session = source(t);
  const socketPath = path.join(session.cwd, "opener.sock");
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  let socket: net.Socket | undefined;
  const connected = new Promise<net.Socket>((resolve) => server.once("connection", (client) => { socket = client; resolve(client); }));
  t.after(() => { socket?.destroy(); server.close(); });
  const previousPath = process.env.PATH;
  const previousSocket = process.env.PI_SWITCH_OPENER_SOCKET;
  process.env.PATH = `${session.cwd}${path.delimiter}${previousPath || ""}`;
  process.env.PI_SWITCH_OPENER_SOCKET = socketPath;
  t.after(() => {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    if (previousSocket === undefined) delete process.env.PI_SWITCH_OPENER_SOCKET; else process.env.PI_SWITCH_OPENER_SOCKET = previousSocket;
  });
  const quote = (text: string) => `'${text.replaceAll("'", `'"'"'`)}'`;
  fs.writeFileSync(path.join(session.cwd, process.platform === "darwin" ? "open" : "xdg-open"),
    `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fileURLToPath(new URL("./test/browser-opener-fixture.mjs", import.meta.url)))} "$@"\n`, { mode: 0o700 });
  const endpoint = await tau(t, (req, res) => {
    if (req.method === "GET") json(res, { sessions: [] });
    else json(res, { session: { id: "long-lived-browser", sessionFile: session.sessionFile }, started: true });
  });
  const prepared = await prepareTauDestination(session, endpoint);
  const started = Date.now();
  const result = await prepared.start();
  assert.ok(Date.now() - started < 2_000, "handoff waits for spawn, not opener termination");
  assert.doesNotMatch(result, /Browser could not be opened/);
  const client = await connected;
  const input = createInterface({ input: client });
  const received = input[Symbol.asyncIterator]();
  const info = JSON.parse((await received.next()).value!) as { pid: number; url: string };
  assert.match(info.url, /\/#session=long-lived-browser$/);
  assert.ok(result.includes(info.url));
  assert.equal((await received.next()).value, "survived", "opener survives the former five-second timeout");
  process.kill(info.pid, 0);
  client.write("finish\n");
  await new Promise<void>((resolve) => client.once("close", resolve));
  input.close();
});

test("browser failure after confirmed resume returns a usable encoded link, never a failed handoff", async (t) => {
  const session = source(t);
  const endpoint = await tau(t, (req, res) => {
    if (req.method === "GET") json(res, { sessions: [] });
    else json(res, { session: { id: "live /?#", sessionFile: session.sessionFile }, started: true });
  });
  const prepared = await prepareTauDestination(session, endpoint, async (url) => {
    assert.match(url, /\/#session=live%20%2F%3F%23$/);
    throw new Error("private-password from opener");
  }, { endpoint, pid: 123, logFile: "/private/tau/server.log", started: true,
    browserUrls: ["https://private-user:private-password@pc:3443/"] });
  const result = await prepared.start();
  assert.match(result, /Browser could not be opened/);
  assert.match(result, /PID: 123; log: \/private\/tau\/server.log/);
  assert.match(result, /independently of this panel/);
  assert.ok(result.includes("https://pc:3443/#session=live%20%2F%3F%23"));
  assert.doesNotMatch(result, /private-user|private-password/);
});

test("a missing native opener preserves the confirmed transfer and manual URL", async (t) => {
  const session = source(t);
  const endpoint = await tau(t, (req, res) => {
    if (req.method === "GET") json(res, { sessions: [] });
    else json(res, { session: { id: "manual", sessionFile: session.sessionFile }, started: true });
  });
  const previous = process.env.PATH;
  process.env.PATH = session.cwd;
  t.after(() => { if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous; });
  const result = await (await prepareTauDestination(session, endpoint)).start();
  assert.match(result, /\/#session=manual/);
  assert.match(result, /open this URL manually/);
  assert.doesNotMatch(result, /private-password/);
});

for (const safe of [true, false]) {
  test(`Tau startup rejection with childStopped=${safe} reports failure without exposing server errors`, async (t) => {
    const session = source(t);
    const endpoint = await tau(t, (req, res) => {
      if (req.method === "GET") json(res, { sessions: [] });
      else json(res, { error: "secret private-password", childStopped: safe }, safe ? 400 : 503);
    });
    const prepared = await prepareTauSwitch(session, endpoint);
    await assert.rejects(prepared.start(), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /secret|private-password/);
      return true;
    });
  });
}

for (const mode of ["disconnect", "bad-json", "wrong-file", "ownership"] as const) {
  test(`Tau ${mode} fails without displaying private response data`, async (t) => {
    const session = source(t);
    const endpoint = await tau(t, (req, res) => {
      if (req.method === "GET") { json(res, { sessions: [] }); return; }
      if (mode === "disconnect") req.socket.destroy();
      if (mode === "bad-json") res.end("private-password");
      if (mode === "wrong-file") json(res, { session: { id: "wrong", sessionFile: "/wrong" }, started: true });
      if (mode === "ownership") json(res, { error: "owned by another writer" }, 409);
    });
    const prepared = await prepareTauSwitch(session, endpoint);
    await assert.rejects(prepared.start(), (error: unknown) => error instanceof Error && !/private-password/.test(error.message));
  });
}

for (const started of [false, undefined]) {
  test(`Tau reused or unacknowledged startup (${started}) must confirm refresh`, async (t) => {
    const session = source(t);
    const endpoint = await tau(t, (req, res) => {
      if (req.method === "GET") json(res, { sessions: [] });
      else json(res, { session: { id: "existing", sessionFile: session.sessionFile }, started, reused: true });
    });
    const prepared = await prepareTauSwitch(session, endpoint);
    await assert.rejects(prepared.start(), /did not confirm a newly started or refreshed session/);
  });
}

test("Herdr default discovery uses its reported local socket without starting a server", async (t) => {
  const session = source(t);
  const endpoint = path.join(session.cwd, "default.sock");
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(endpoint, resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const calls: string[][] = [];
  await prepareHerdrSwitch(session, undefined, async (args) => {
    calls.push(args);
    return JSON.stringify({ server: { running: true, socket: endpoint } });
  });
  assert.deepEqual(calls, [["status", "--json"]]);
  await assert.rejects(prepareHerdrSwitch(session, undefined, async () => JSON.stringify({ server: { running: false } })), /No running local Herdr server/);
});

test("preflight refuses remote Tau but an existing idle tab can be refreshed without duplication", async (t) => {
  const session = source(t);
  await assert.rejects(prepareTauSwitch(session, "https://user:secret@example.org"), /local Tau/);
  const calls: string[] = [];
  const endpoint = await tau(t, async (req, res) => {
    calls.push(`${req.method} ${req.url}`);
    if (req.method === "GET") json(res, { sessions: [{ id: "existing", sessionFile: session.sessionFile }] });
    else {
      assert.equal((await body(req)).refresh, true);
      json(res, { session: { id: "existing", sessionFile: session.sessionFile }, started: false, reused: true, refreshed: true });
    }
  });
  const prepared = await prepareTauSwitch(session, endpoint);
  assert.deepEqual(calls, ["GET /api/live-sessions"]);
  assert.match(await prepared.start(), /Tau tab existing/);
  assert.deepEqual(calls, ["GET /api/live-sessions", "POST /api/live-sessions/resume"]);
});

test("a busy existing Tau tab is refused without being deleted or cancelled", async (t) => {
  const session = source(t);
  const calls: string[] = [];
  const endpoint = await tau(t, (req, res) => {
    calls.push(`${req.method} ${req.url}`);
    if (req.method === "GET") json(res, { sessions: [{ id: "busy", sessionFile: session.sessionFile }] });
    else json(res, { error: "busy" }, 409);
  });
  await assert.rejects((await prepareTauSwitch(session, endpoint)).start(), /busy or has queued input/);
  assert.deepEqual(calls, ["GET /api/live-sessions", "POST /api/live-sessions/resume"]);
});

test("Herdr uses a fresh unfocused workspace and verifies the exact session through existing ping", async (t) => {
  const session = source(t);
  const endpoint = path.join(session.cwd, "herdr.sock");
  const local = net.createServer();
  await new Promise<void>((resolve) => local.listen(endpoint, resolve));
  t.after(() => new Promise<void>((resolve) => local.close(() => resolve())));
  const calls: string[][] = [];
  let control: net.Server | undefined;
  let controlDirectory: string | undefined;
  let starts = 0;
  const prepared = await prepareHerdrSwitch(session, endpoint, async (args) => {
    calls.push(args);
    if (args[0] === "status") return JSON.stringify({ client: {}, server: { running: true, socket: endpoint } });
    if (args[0] === "workspace") {
      assert.ok(args.includes("--no-focus"));
      assert.ok(!args.some((arg) => /^HERDR_(PANE|TAB|WORKSPACE)_ID=/.test(arg)));
      const socket = args.find((arg) => arg.startsWith("PI_ORCHESTRATION_CONTROL="))!.split("=")[1]!;
      controlDirectory = path.dirname(socket);
      control = net.createServer((client) => client.once("data", (raw) => {
        assert.deepEqual(JSON.parse(String(raw)), { kind: "ping", sessionFile: session.sessionFile });
        client.end('{"dispatched":true}\n');
      }));
      await new Promise<void>((resolve) => control!.listen(socket, resolve));
      return JSON.stringify({ result: { workspace: { workspace_id: "w-owned" }, root_pane: { pane_id: "w-owned:p1" } } });
    }
    starts++;
    if (starts === 1) throw Object.assign(new Error("shell not ready"), { stderr: '{"error":{"code":"agent_pane_busy"}}' });
    assert.equal(args[args.indexOf("--session") + 1], session.sessionFile);
    assert.deepEqual(args.slice(args.indexOf("--session") + 2, -2), session.args);
    return "Agent started successfully";
  });
  t.after(async () => {
    if (control) await new Promise<void>((resolve) => control!.close(() => resolve()));
    if (controlDirectory) fs.rmSync(controlDirectory, { recursive: true, force: true });
  });
  assert.deepEqual(calls, [["status", "--json"]]);
  assert.equal(await prepared.start(), "Herdr workspace w-owned, pane w-owned:p1");
  assert.equal(starts, 2);
  assert.ok(!calls.some((args) => args.includes("close")));
});

test("Herdr failed agent startup closes only its own workspace", async (t) => {
  const session = source(t);
  const endpoint = path.join(session.cwd, "herdr.sock");
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(endpoint, resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const calls: string[][] = [];
  const prepared = await prepareHerdrSwitch(session, endpoint, async (args) => {
    calls.push(args);
    if (args[0] === "status") return JSON.stringify({ server: { running: true, socket: endpoint } });
    if (args[1] === "close") return "";
    if (args[0] === "workspace") return JSON.stringify({ result: { workspace: { workspace_id: "w-owned" }, root_pane: { pane_id: "w-owned:p1" } } });
    throw new Error("start failed");
  });
  await assert.rejects(prepared.start(), /Herdr switch failed/);
  assert.deepEqual(calls.at(-1), ["workspace", "close", "w-owned"]);
});

test("terminal ping checks the current session without submitting input", async (t) => {
  const session = source(t);
  const socket = path.join(session.cwd, "input.sock");
  const previous = process.env.PI_ORCHESTRATION_CONTROL;
  process.env.PI_ORCHESTRATION_CONTROL = socket;
  t.after(() => { if (previous === undefined) delete process.env.PI_ORCHESTRATION_CONTROL; else process.env.PI_ORCHESTRATION_CONTROL = previous; });
  const handlers = new Map<string, (_event: unknown, ctx: ExtensionContext) => Promise<void>>();
  terminalInput({
    on: (event: string, callback: (_event: unknown, ctx: ExtensionContext) => Promise<void>) => { handlers.set(event, callback); },
    sendUserMessage: () => assert.fail("ping submitted a prompt"),
  } as unknown as ExtensionAPI);
  const ctx = { sessionManager: { getSessionFile: () => session.sessionFile } } as unknown as ExtensionContext;
  await handlers.get("session_start")!({}, ctx);
  try {
    await terminalRequest(socket, { kind: "ping", sessionFile: session.sessionFile });
    await terminalRequest(socket, { kind: "ping" });
    await assert.rejects(terminalRequest(socket, { kind: "ping", sessionFile: "/different.jsonl" }), /expected session/);
  } finally { await handlers.get("session_shutdown")!({}, ctx); }
});

