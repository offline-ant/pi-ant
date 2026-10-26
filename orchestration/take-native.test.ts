import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { TOOL_SELECTION_ENTRY } from "../extensions/tool-selection.ts";
import { flushSessionFile } from "./context.ts";
import { prepareHerdrSwitch, switchEnvironment } from "./switch-destinations.ts";
import { terminalRequest } from "./terminal-input.ts";
import { localTauConnection } from "./tau-server.ts";
import { ownTakeSocket, takeSocket, listenTake, requestTake, listTakeCandidates, type TakeDescription } from "./session-take.ts";

const execute = promisify(execFile);
async function until(check: () => boolean | Promise<boolean>, label: string, milliseconds = 30_000): Promise<void> {
  const deadline = Date.now() + milliseconds;
  while (!await check()) { assert.ok(Date.now() < deadline, `Timed out: ${label}`); await delay(40); }
}
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
interface Trace { event: string; pid: number; file: string; cwd: string; pane: string; control: string; model: string; thinking: string; tools: string[]; branch: string[]; draft: string }

test("native take moves Tau into the current Herdr pane and back without inference, drafts or stale branches", {
  skip: process.env.PI_TAKE_NATIVE !== "1", timeout: 180_000,
}, async t => {
  assert.equal(process.env.HERDR_ENV, "1");
  const endpoint = process.env.HERDR_SOCKET_PATH!;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-take-native-"));
  const agentDir = path.join(directory, "agent");
  const sessionDir = path.join(agentDir, "sessions", "fixture");
  const firstCwd = path.join(directory, "first");
  const secondCwd = path.join(directory, "second");
  for (const dir of [sessionDir, firstCwd, secondCwd]) fs.mkdirSync(dir, { recursive: true });
  const traceFile = path.join(directory, "trace.jsonl");
  const traces = (): Trace[] => fs.existsSync(traceFile) ? fs.readFileSync(traceFile, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
    defaultProvider: "take-fixture", defaultModel: "one", compaction: { enabled: false }, retry: { enabled: false },
    extensions: [fileURLToPath(new URL("../extensions/tools.ts", import.meta.url)), fileURLToPath(new URL("./extensions/switch.ts", import.meta.url)),
      fileURLToPath(new URL("./test/take-native-fixture.ts", import.meta.url)), path.join(process.env.HOME!, ".pi/agent/extensions/herdr-agent-state.ts")],
  }));
  const seed = (cwd: string, model: string, tools: string[]) => {
    const session = SessionManager.create(cwd, sessionDir);
    session.appendModelChange("take-fixture", model);
    session.appendThinkingLevelChange("high");
    session.appendCustomEntry(TOOL_SELECTION_ENTRY, { enabledTools: tools });
    const selected = session.appendCustomEntry("take:selected", {});
    const abandoned = session.appendCustomEntry("take:abandoned", {});
    flushSessionFile(session, session.getSessionFile()!);
    return { file: session.getSessionFile()!, selected, abandoned };
  };
  const wanted = seed(firstCwd, "one", ["read"]);
  const initial = seed(secondCwd, "two", ["read", "bash"]);
  const env = { ...process.env, ...switchEnvironment({ ...process.env, PI_CODING_AGENT_DIR: agentDir }),
    PI_CODING_AGENT_SESSION_DIR: path.dirname(sessionDir), PI_TAKE_TRACE: traceFile,
    TAU_HOST: "127.0.0.1", TAU_PORT: "0", TAU_HTTP_PORT: "0", TAU_USER: "", TAU_PASS: "",
    // Autostart can inherit the launching terminal. These must not become the
    // identity of every Tau child, or collide with the real Herdr Pi listener.
    HERDR_ENV: "1", HERDR_SOCKET_PATH: endpoint, HERDR_PANE_ID: process.env.HERDR_PANE_ID || "inherited-server-pane",
    PI_ORCHESTRATION_CONTROL: process.env.PI_ORCHESTRATION_CONTROL || "/tmp/inherited-server-control",
    PI_ORCHESTRATION_TARGET: "inherited-server-target" };
  const tau = spawn(process.execPath, [fileURLToPath(new URL("../../tau/bin/tau.js", import.meta.url))], { cwd: directory, env, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = ""; tau.stderr.on("data", chunk => { stderr += String(chunk); });
  let workspace = "";
  let websocket: WebSocket | undefined;
  const notifications: unknown[] = [];
  const herdr = async (args: string[]) => (await execute(process.env.HERDR_BIN_PATH || "herdr", args, { env: { ...process.env, HERDR_SOCKET_PATH: endpoint }, timeout: 60_000 })).stdout;
  try {
    const publication = path.join(agentDir, "tau", "server.json");
    await until(() => fs.existsSync(publication), `isolated Tau readiness: ${stderr}`);
    const { base, headers } = localTauConnection(JSON.parse(fs.readFileSync(publication, "utf8")).endpoint);
    const api = async (route: string, body?: unknown) => {
      const response = await fetch(base + route, { method: body ? "POST" : "GET", headers, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60_000) });
      assert.ok(response.ok, `${route}: ${response.status}`);
      return response.json() as Promise<Record<string, unknown>>;
    };
    websocket = new WebSocket(base.replace("http:", "ws:") + "/ws");
    websocket.addEventListener("message", event => {
      const data = JSON.parse(String(event.data));
      if (data.type === "event" && data.event?.type === "extension_ui_request" && data.event.method === "notify") notifications.push(data.event);
      if (data.type === "event" && data.event?.type === "extension_ui_request" && data.event.method === "select") {
        websocket!.send(JSON.stringify({ type: "extension_ui_response", sessionId: data.sessionId, id: data.event.id, value: data.event.options[0] }));
      }
    });
    await new Promise<void>((resolve, reject) => { websocket!.addEventListener("open", () => resolve(), { once: true }); websocket!.addEventListener("error", reject, { once: true }); });
    const created = await api("/api/live-sessions/resume", { filePath: wanted.file, cwd: firstCwd, args: ["--provider", "take-fixture", "--model", "one", "--thinking", "high"] });
    const source = created.session as { id: string; pid: number };
    await api("/api/rpc", { type: "prompt", sessionId: source.id, message: `/take-fixture-branch ${wanted.selected}` });
    await until(() => traces().some(entry => entry.pid === source.pid && entry.event === "branch"), "Tau selected branch");
    const sourceSocket = takeSocket(`pid:${source.pid}`);
    assert.equal(traces().find(entry => entry.pid === source.pid)?.pane, undefined, "Tau clears its server's terminal identity");
    assert.equal((await listTakeCandidates("tau", { ...env, PI_ORCHESTRATION_HOST: "", PI_ORCHESTRATION_ENDPOINT: "" })).length, 1, "Tau candidate discovery reaches the per-PID listener");
    const fresh = (await api("/api/live-sessions", { cwd: secondCwd })).session as { id: string; pid: number };
    await api("/api/rpc", { type: "prompt", sessionId: fresh.id, message: "/take-fixture-state" });
    await until(() => traces().some(entry => entry.pid === fresh.pid && entry.event === "state"), "unwritten Tau command without a header");
    assert.equal((await listTakeCandidates("tau", { ...env, PI_ORCHESTRATION_HOST: "", PI_ORCHESTRATION_ENDPOINT: "" })).length, 1, "unwritten sessions are not takeover candidates");
    const stubSocket = takeSocket(`fixture:${directory}`);
    const stub = await listenTake(stubSocket, (request, reply) => {
      assert.equal(request.kind, "load", "source readiness uses one load, not a second discovery round-trip");
      void reply(undefined, "Receiver became busy before loading");
    });
    try {
      const before = traces().filter(entry => entry.pid === source.pid && entry.event === "resume").length;
      await api("/api/rpc", { type: "prompt", sessionId: source.id, message: "/take-fixture-ugo on" });
      await assert.rejects(requestTake(sourceSocket, { kind: "take", sessionFile: wanted.file, receiver: stubSocket, receiverSession: initial.file }), /Stop Ugo/);
      assert.equal(traces().filter(entry => entry.pid === source.pid && entry.event === "resume").length, before, "a newly managed source is rejected before releasing its runtime");
      await api("/api/rpc", { type: "prompt", sessionId: source.id, message: "/take-fixture-ugo off" });
      await assert.rejects(requestTake(sourceSocket, { kind: "take", sessionFile: initial.file, receiver: stubSocket, receiverSession: initial.file }), /conversation changed/);
      await assert.rejects(requestTake(sourceSocket, { kind: "take", sessionFile: wanted.file, receiver: stubSocket, receiverSession: initial.file }), /Receiver became busy/);
      assert.ok(alive(source.pid), "failed receiver readiness leaves the source runtime intact");
      assert.equal(traces().filter(entry => entry.pid === source.pid && entry.event === "resume").length, before, "failure does not reload the source");
      assert.equal((await requestTake<TakeDescription>(sourceSocket, { kind: "describe" })).sessionFile, wanted.file);
    } finally { await new Promise<void>(resolve => stub.close(() => resolve())); }
    const prepared = await prepareHerdrSwitch({ sessionFile: initial.file, cwd: secondCwd,
      args: ["--provider", "take-fixture", "--model", "two", "--thinking", "high"], env: { ...env, ...switchEnvironment(env) } }, endpoint);
    const location = await prepared.start();
    workspace = /workspace ([^,]+)/.exec(location)![1];
    const pane = /pane (\S+)/.exec(location)![1];
    await until(() => traces().some(entry => entry.pane === pane), "Herdr receiver");
    const receiver = traces().find(entry => entry.pane === pane)!;
    await herdr(["pane", "send-text", pane, "untouched human draft"]);
    await terminalRequest(receiver.control, { kind: "prompt", text: "/take tau" });
    await until(async () => (await herdr(["pane", "read", pane, "--source", "visible"])).includes("Take an idle session from tau"), "take picker");
    await herdr(["pane", "send-keys", pane, "Enter"]);
    await until(() => !alive(source.pid), "Tau source exits after Herdr is ready", 60_000);
    await terminalRequest(receiver.control, { kind: "prompt", text: "/take-fixture-state" });
    await until(() => traces().some(entry => entry.pid === receiver.pid && entry.event === "state" && entry.file === wanted.file), "taken Herdr state");
    const taken = traces().findLast(entry => entry.pid === receiver.pid && entry.event === "state")!;
    assert.equal(taken.cwd, firstCwd); assert.equal(taken.model, "one"); assert.equal(taken.thinking, "high");
    assert.deepEqual(taken.tools, ["read"]); assert.equal(taken.draft, "untouched human draft");
    assert.ok(taken.branch.includes(wanted.selected)); assert.ok(!taken.branch.includes(wanted.abandoned));
    assert.ok(alive(receiver.pid), "the original Pi process and pane are reused");
    const control = ownTakeSocket("herdr", { HERDR_SOCKET_PATH: endpoint, HERDR_PANE_ID: pane });
    assert.equal((await requestTake<TakeDescription>(control, { kind: "describe" })).sessionFile, wanted.file);
    const second = (await api("/api/live-sessions/resume", { filePath: initial.file, cwd: secondCwd, args: ["--provider", "take-fixture", "--model", "two", "--thinking", "low"] })).session as { id: string; pid: number };
    const discoverable = await listTakeCandidates("herdr", { ...env, HERDR_ENV: "", HERDR_SOCKET_PATH: "", PI_ORCHESTRATION_HOST: "web", PI_ORCHESTRATION_ENDPOINT: `${base}` });
    assert.ok(discoverable.some(candidate => candidate.socket === control), "an explicitly empty Herdr socket uses CLI discovery");
    await api("/api/rpc", { type: "prompt", sessionId: second.id, message: "/take herdr" });
    await until(() => !alive(receiver.pid), "Herdr source exits after Tau is ready", 60_000);
    await until(async () => (await api(`/api/live-sessions/${second.id}/snapshot`)).sessionFile === wanted.file, "Tau authoritative replacement snapshot");
    await api("/api/rpc", { type: "prompt", sessionId: second.id, message: "/take-fixture-state" });
    await until(() => traces().some(entry => entry.pid === second.pid && entry.event === "state" && entry.file === wanted.file), "taken Tau state");
    const final = traces().findLast(entry => entry.pid === second.pid && entry.event === "state")!;
    assert.equal(final.cwd, firstCwd); assert.equal(final.model, "one"); assert.equal(final.thinking, "high");
    assert.deepEqual(final.tools, ["read"]); assert.ok(final.branch.includes(wanted.selected)); assert.ok(!final.branch.includes(wanted.abandoned));
    assert.ok(!traces().some(entry => entry.event === "unexpected-inference"));
    assert.ok((await herdr(["pane", "read", pane, "--source", "visible"])).length > 0, "the Herdr pane survives source exit");
    t.diagnostic("Two-way takeover reused both receiving Pi processes, restored cross-cwd/model/tools/non-tip branch, kept the human draft, closed only source Pi processes, and made no inference requests.");
  } catch (error) { t.diagnostic(`Trace ${JSON.stringify(traces())}; notices ${JSON.stringify(notifications)}; server stderr ${stderr}`); throw error; }
  finally {
    websocket?.close();
    if (workspace) await herdr(["workspace", "close", workspace]).catch(() => {});
    tau.kill("SIGTERM");
    await until(() => !alive(tau.pid!), "isolated Tau cleanup", 15_000);
    for (const entry of traces()) {
      if (entry.control) fs.rmSync(path.dirname(entry.control), { recursive: true, force: true });
      const socket = entry.pane ? ownTakeSocket("herdr", { HERDR_SOCKET_PATH: endpoint, HERDR_PANE_ID: entry.pane }) : takeSocket(`pid:${entry.pid}`);
      fs.rmSync(socket, { force: true });
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
