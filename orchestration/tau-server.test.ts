import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test, { type TestContext } from "node:test";
import { ensureTauServer } from "./tau-server.ts";

const execute = promisify(execFile);
interface Launch { pid: number; argv: string[]; stdin: string | null; env: Record<string, string | null> }
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
}
async function gone(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (alive(pid)) {
    // A detached child can briefly remain a zombie until its init reaps it.
    if (process.platform === "linux" && /\) Z /.test(fs.readFileSync(`/proc/${pid}/stat`, "utf8"))) return;
    assert.ok(Date.now() < deadline, `Fixture process ${pid} did not stop`);
    await delay(20);
  }
}
function fixture(t: TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tau-start-test-"));
  const bin = path.join(directory, "bin");
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(directory, "tau"));
  const executable = path.join(bin, "pi-tau-web-server");
  const entry = fileURLToPath(new URL("./test/tau-autostart-fixture.mjs", import.meta.url));
  fs.writeFileSync(executable, `#!${process.execPath}\nimport ${JSON.stringify(entry)};\n`, { mode: 0o700 });
  // An extensionless executable defaults to CommonJS; this local package opts in.
  fs.writeFileSync(path.join(directory, "package.json"), '{"type":"module"}');
  const env: NodeJS.ProcessEnv = {
    ...process.env, PATH: bin, PI_CODING_AGENT_DIR: directory, PI_ORCHESTRATION_HOST: "herdr",
    PI_ORCHESTRATION_ENDPOINT: "/private/source.sock", PI_ORCHESTRATION_CONTROL: "/old/control.sock", PI_ORCHESTRATION_TARGET: "old-target", PI_NESTED: "2",
    HERDR_SOCKET_PATH: "/private/herdr.sock", HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", TMUX: "/old/tmux,1,0", DISPLAY: ":fixture",
    PI_CODING_AGENT_SESSION_DIR: path.join(directory, "sessions"), FIXTURE_TAU_MODE: "ready",
    TAU_HOST: "0.0.0.0", TAU_USER: "fixture", TAU_PASS: "private-password",
  };
  const launches = (): Launch[] => {
    const file = path.join(directory, "launches.jsonl");
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Launch) : [];
  };
  t.after(async () => {
    for (const launch of launches()) {
      if (alive(launch.pid)) process.kill(launch.pid, "SIGKILL");
      await gone(launch.pid);
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, bin, executable, env, launches, runtime: path.join(directory, "tau", "server.json") };
}

async function server(t: TestContext, status = 200) {
  const app = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, `Basic ${Buffer.from("fixture:private-password").toString("base64")}`);
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ sessions: [] }));
  });
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => { app.close(() => resolve()); app.closeAllConnections(); }));
  return `http://fixture:private-password@127.0.0.1:${(app.address() as net.AddressInfo).port}`;
}

const timing = { startupTimeoutMs: 5_000, requestTimeoutMs: 1_000, stopTimeoutMs: 500 };

test("absent Tau starts detached with configured host/auth, private logs and cleared source identities; later calls reuse it", async (t) => {
  const f = fixture(t);
  const result = await ensureTauServer(f.env, timing);
  assert.equal(result.started, true);
  assert.equal(result.pid, f.launches()[0]!.pid);
  assert.equal(fs.statSync(result.logFile!).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(f.runtime)).mode & 0o777, 0o700);
  assert.ok(!fs.existsSync(path.join(f.directory, "tau", "startup.lock")));
  const launch = f.launches()[0]!;
  assert.deepEqual(launch.argv, []);
  for (const key of ["TAU_HOST", "TAU_USER", "TAU_PASS"]) assert.equal(launch.env[key], f.env[key]);
  assert.deepEqual(result.browserUrls, ["https://pc:3443", "https://127.0.0.1:3443"]);
  if (process.platform === "linux") assert.equal(launch.stdin, "/dev/null");
  assert.equal(launch.env.PI_CODING_AGENT_DIR, f.directory);
  assert.equal(launch.env.PI_CODING_AGENT_SESSION_DIR, f.env.PI_CODING_AGENT_SESSION_DIR);
  assert.equal(launch.env.HERDR_SOCKET_PATH, f.env.HERDR_SOCKET_PATH);
  assert.equal(launch.env.DISPLAY, ":fixture");
  for (const key of ["PI_NESTED", "PI_ORCHESTRATION_HOST", "PI_ORCHESTRATION_ENDPOINT", "PI_ORCHESTRATION_TARGET", "PI_ORCHESTRATION_CONTROL", "HERDR_ENV", "HERDR_PANE_ID", "TMUX"]) assert.equal(launch.env[key], null);
  const reused = await ensureTauServer(f.env, timing);
  assert.equal(reused.pid, result.pid);
  assert.equal(reused.started, false);
  assert.deepEqual(reused.browserUrls, result.browserUrls);
  assert.equal(f.launches().length, 1);
});

test("autostart leaves host and authentication defaults to Tau when no overrides are present", async (t) => {
  const f = fixture(t);
  for (const key of ["TAU_HOST", "TAU_USER", "TAU_PASS"]) delete f.env[key];
  await ensureTauServer(f.env, timing);
  const launch = f.launches()[0]!;
  assert.deepEqual(launch.argv, []);
  for (const key of ["TAU_HOST", "TAU_USER", "TAU_PASS"]) assert.equal(launch.env[key], null);
});

test("concurrent callers serialize startup and share one server", async (t) => {
  const f = fixture(t);
  const results = await Promise.all([ensureTauServer(f.env, timing), ensureTauServer(f.env, timing), ensureTauServer(f.env, timing)]);
  assert.equal(new Set(results.map((result) => result.pid)).size, 1);
  assert.equal(results.filter((result) => result.started).length, 1);
  assert.equal(f.launches().length, 1);
});

test("concurrent processes share one server which survives their exit and is reused later", async (t) => {
  const f = fixture(t);
  const client = fileURLToPath(new URL("./test/tau-autostart-client.ts", import.meta.url));
  const start = async () => JSON.parse((await execute(process.execPath, [client], { env: f.env, timeout: 10_000 })).stdout) as { pid: number; started: boolean };
  const initial = await Promise.all([start(), start()]);
  assert.equal(initial.filter((result) => result.started).length, 1);
  const pid = initial[0]!.pid;
  assert.equal(initial[1]!.pid, pid);
  assert.ok(alive(pid));
  const reused = await start();
  assert.equal(reused.pid, pid);
  assert.equal(reused.started, false);
  assert.equal(f.launches().length, 1);
});

test("dead published owner permits startup; stale startup claims require explicit recovery", async (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.runtime, JSON.stringify({ endpoint: "http://127.0.0.1:1", pid: 2_000_000_000 }));
  const claim = path.join(f.directory, "tau", "startup.lock");
  fs.writeFileSync(claim, JSON.stringify({ pid: 2_000_000_000 }));
  await assert.rejects(ensureTauServer(f.env, timing), /owner stopped/);
  assert.equal(f.launches().length, 0);
  fs.unlinkSync(claim);
  assert.equal((await ensureTauServer(f.env, timing)).started, true);
});

for (const [name, browserUrls] of Object.entries({
  http: ["http://127.0.0.1:3001"], malformed: ["not a URL"], invalidType: null,
})) {
  test(`dead owner's ${name} browser metadata does not block startup or readiness`, async (t) => {
    const f = fixture(t);
    const pid = 2_000_000_000;
    assert.equal(alive(pid), false);
    fs.writeFileSync(f.runtime, JSON.stringify({ endpoint: "http://127.0.0.1:1", pid, browserUrls }));
    const result = await ensureTauServer(f.env, timing);
    assert.equal(result.started, true);
    assert.equal(f.launches().length, 1);
    assert.equal(result.pid, f.launches()[0]!.pid);
    assert.deepEqual(result.browserUrls, ["https://pc:3443", "https://127.0.0.1:3443"]);
    assert.equal((await ensureTauServer(f.env, timing)).started, false);
  });
}

test("live published server is reused without finding a CLI", async (t) => {
  const f = fixture(t);
  fs.unlinkSync(f.executable);
  const endpoint = await server(t);
  fs.writeFileSync(f.runtime, JSON.stringify({ endpoint, pid: process.pid }));
  assert.equal((await ensureTauServer(f.env, timing)).endpoint, endpoint);
  assert.equal(f.launches().length, 0);
});

test("published HTTPS browser origins may use host names and a different port from loopback HTTP", async (t) => {
  const f = fixture(t);
  const endpoint = await server(t);
  const browserUrls = ["https://pc:3443/", "https://192.0.2.1:3443", "https://192.0.2.2:3443", "https://127.0.0.1:3443", "https://[::1]:3443", "https://pc:3443"];
  assert.equal(new URL(endpoint).protocol, "http:");
  assert.notEqual(new URL(endpoint).port, "3443");
  fs.writeFileSync(f.runtime, JSON.stringify({ endpoint, pid: process.pid, browserUrls }));
  assert.deepEqual((await ensureTauServer(f.env, timing)).browserUrls, ["https://pc:3443", "https://192.0.2.1:3443", "https://192.0.2.2:3443", "https://127.0.0.1:3443", "https://[::1]:3443"]);
  assert.equal(f.launches().length, 0);
});

for (const [name, browserUrls] of Object.entries({
  null: null, string: "private-password", number: [123], http: ["http://127.0.0.1:3443"], wildcard: ["https://0.0.0.0:3443"],
  ipv6Wildcard: ["https://[::]:3443"], credentials: ["https://fixture:private-password@127.0.0.1:3443"],
  path: ["https://127.0.0.1:3443/private-password"], query: ["https://127.0.0.1:3443/?private-password"], fragment: ["https://127.0.0.1:3443/#private-password"],
})) {
  test(`invalid ${name} browser URL publication is rejected without exposing its contents`, async (t) => {
    const f = fixture(t);
    fs.writeFileSync(f.runtime, JSON.stringify({ endpoint: "http://fixture:private-password@127.0.0.1:3001", pid: process.pid, browserUrls }));
    await assert.rejects(ensureTauServer(f.env, timing), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Malformed Tau browser URLs/);
      assert.doesNotMatch(error.message, /private-password/);
      return true;
    });
    assert.equal(f.launches().length, 0);
  });
}

for (const mode of ["unreachable", "auth", "malformed", "inaccessible"] as const) {
  test(`a live/config ${mode} failure never starts another Tau or leaks credentials`, async (t) => {
    const f = fixture(t);
    if (mode === "inaccessible") fs.mkdirSync(f.runtime);
    else if (mode === "malformed") fs.writeFileSync(f.runtime, "private-password malformed");
    else fs.writeFileSync(f.runtime, JSON.stringify({ endpoint: mode === "auth" ? await server(t, 401) : "http://fixture:private-password@127.0.0.1:1", pid: process.pid }));
    await assert.rejects(ensureTauServer(f.env, timing), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /private-password/);
      return true;
    });
    assert.equal(f.launches().length, 0);
  });
}

test("explicit endpoint is authoritative and a failed explicit endpoint never autostarts", async (t) => {
  const f = fixture(t);
  const endpoint = await server(t);
  fs.writeFileSync(f.runtime, "malformed but irrelevant");
  const env = { ...f.env, PI_ORCHESTRATION_HOST: "web", PI_ORCHESTRATION_ENDPOINT: endpoint };
  assert.equal((await ensureTauServer(env, timing)).endpoint, endpoint);
  await assert.rejects(ensureTauServer({ ...env, PI_ORCHESTRATION_ENDPOINT: "http://127.0.0.1:1" }, timing), /not restarted or replaced/);
  await assert.rejects(ensureTauServer({ ...env, PI_ORCHESTRATION_ENDPOINT: "" }, timing), /requires PI_ORCHESTRATION_ENDPOINT/);
  assert.equal(f.launches().length, 0);
});

test("missing executable fails before transfer and releases the startup claim", async (t) => {
  const f = fixture(t);
  fs.unlinkSync(f.executable);
  await assert.rejects(ensureTauServer(f.env, timing), /Could not start pi-tau-web-server/);
  assert.ok(!fs.existsSync(path.join(f.directory, "tau", "startup.lock")));
  assert.equal(f.launches().length, 0);
});

for (const mode of ["unpublished", "ignore-term", "auth", "exit"] as const) {
  test(`owned unready ${mode} child is confirmed stopped before reporting startup failure`, async (t) => {
    const f = fixture(t);
    f.env.FIXTURE_TAU_MODE = mode;
    await assert.rejects(ensureTauServer(f.env, { ...timing, startupTimeoutMs: 400, stopTimeoutMs: 100 }), /timed out|HTTP 401|Could not start/);
    assert.equal(f.launches().length, 1);
    assert.equal(alive(f.launches()[0]!.pid), false);
    assert.ok(!fs.existsSync(path.join(f.directory, "tau", "startup.lock")));
  });
}
