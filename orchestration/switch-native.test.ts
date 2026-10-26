import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as https from "node:https";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { TOOL_SELECTION_ENTRY } from "../extensions/tool-selection.ts";
import { flushSessionFile } from "./context.ts";
import { parseWebEndpoint } from "./hosts/web.ts";
import { prepareHerdrSwitch, switchEnvironment } from "./switch-destinations.ts";
import { terminalRequest } from "./terminal-input.ts";

const exec = promisify(execFile);
const enabled = process.env.PI_SWITCH_NATIVE === "1";
interface Trace {
  event: string; pid: number; file: string; sessionId: string; mode: string; host: string;
  pane: string; workspace: string; control: string; cwd: string; model: string; provider: string;
  thinking: string; tools: string[]; branch: string[];
}
interface LiveSession { id: string; sessionFile: string }
interface Publication { endpoint: string; pid: number; browserUrls?: string[] }
async function until(check: () => boolean | Promise<boolean>, message: string, timeout = 30_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!await check()) {
    assert.ok(Date.now() < deadline, `Timed out: ${message}`);
    await delay(50);
  }
}
function stopped(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return true; throw error; }
}
const quote = (text: string): string => `'${text.replaceAll("'", `'"'"'`)}'`;
function lines(file: string): string[] {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean) : [];
}

test("native /switch autostarts isolated Tau, keeps every source open and refreshes the retained Tau tab without inference", {
  skip: !enabled, timeout: 240_000,
}, async (t) => {
  assert.equal(process.env.HERDR_ENV, "1", "Run only inside Herdr; never control an outside focused session");
  const endpoint = process.env.HERDR_SOCKET_PATH;
  assert.ok(endpoint);
  const installedTau = (process.env.PATH || "").split(path.delimiter).map((entry) => path.join(entry, "pi-tau-web-server")).find((file) => {
    try { fs.accessSync(file, fs.constants.X_OK); return true; } catch { return false; }
  });
  assert.ok(installedTau, "Install the local fork's pi-tau-web-server on PATH before native verification");
  assert.equal(fs.realpathSync(installedTau), fs.realpathSync(fileURLToPath(new URL("../../tau/bin/tau.js", import.meta.url))), "verify the installed local fork, not another Tau distribution");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-switch-native-"));
  const agentDir = path.join(directory, "agent");
  const sessionDir = path.join(agentDir, "sessions", "fixture");
  const bin = path.join(directory, "test-bin");
  const launches = path.join(directory, "tau-launches.txt");
  const opened = path.join(directory, "opened-urls.txt");
  const publication = path.join(agentDir, "tau", "server.json");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(bin);
  // Invoke the installed executable, recording its unchanged exec PID so even
  // a failed publication can be cleaned up without scanning other processes.
  fs.writeFileSync(path.join(bin, "pi-tau-web-server"), [
    "#!/bin/sh", `printf '%s\\n' \"$$\" >> ${quote(launches)}`,
    `exec ${quote(installedTau)} \"$@\"`, "",
  ].join("\n"), { mode: 0o700 });
  for (const opener of ["xdg-open", "open"]) {
    fs.writeFileSync(path.join(bin, opener), `#!/bin/sh\nprintf '%s\\n' \"$1\" >> ${quote(opened)}\n`, { mode: 0o700 });
  }
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
    defaultProvider: "switch-native-fixture", defaultModel: "one", defaultThinkingLevel: "high",
    compaction: { enabled: false }, retry: { enabled: false },
    extensions: [
      fileURLToPath(new URL("../extensions/tools.ts", import.meta.url)),
      fileURLToPath(new URL("./extensions/switch.ts", import.meta.url)),
      fileURLToPath(new URL("./test/switch-native-fixture.ts", import.meta.url)),
    ],
  }));
  const seed = SessionManager.create(directory, sessionDir);
  seed.appendModelChange("switch-native-fixture", "one");
  seed.appendThinkingLevelChange("high");
  seed.appendCustomEntry(TOOL_SELECTION_ENTRY, { enabledTools: ["read"] });
  const selected = seed.appendCustomEntry("switch-smoke:selected", {});
  const abandoned = seed.appendCustomEntry("switch-smoke:abandoned", {});
  const sessionFile = seed.getSessionFile()!;
  flushSessionFile(seed, sessionFile);
  const trace = (): Trace[] => lines(path.join(directory, "switch-trace.jsonl")).map((line) => JSON.parse(line) as Trace);
  const serverRecord = (): Publication => JSON.parse(fs.readFileSync(publication, "utf8")) as Publication;
  const herdr = async (args: string[]): Promise<Record<string, unknown>> => {
    const result = await exec(process.env.HERDR_BIN_PATH || "herdr", args, { env: { ...process.env, HERDR_SOCKET_PATH: endpoint }, timeout: 120_000 });
    return result.stdout.trim() ? JSON.parse(result.stdout) as Record<string, unknown> : {};
  };
  const freePort = async (): Promise<number> => {
    const listener = net.createServer();
    await new Promise<void>((resolve) => listener.listen(0, "0.0.0.0", resolve));
    const free = (listener.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    return free;
  };
  const port = await freePort();
  const httpsPort = await freePort();
  const workspaces = new Set<string>();
  let base = "";
  let headers: Record<string, string> = {};
  const request = async (route: string, body?: unknown): Promise<Record<string, unknown>> => {
    const response = await fetch(base + route, {
      method: body === undefined ? "GET" : "POST", headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(120_000),
    });
    assert.ok(response.ok, `${route}: HTTP ${response.status}`);
    return await response.json() as Record<string, unknown>;
  };
  const sessions = async (): Promise<LiveSession[]> => (await request("/api/live-sessions")).sessions as LiveSession[];
  try {
    assert.ok(!fs.existsSync(publication), "no Tau exists before the first /switch");
    const source = { sessionFile, cwd: directory,
      args: ["--provider", "switch-native-fixture", "--model", "one", "--thinking", "high", "--no-skills", "--no-context-files", "--no-prompt-templates"],
      env: { ...switchEnvironment({ HOME: directory, PI_CODING_AGENT_DIR: agentDir, HERDR_SOCKET_PATH: endpoint }),
        PATH: `${bin}${path.delimiter}${process.env.PATH || ""}`, PI_CODING_AGENT_SESSION_DIR: path.dirname(sessionDir),
        TAU_HOST: "", TAU_HTTP_PORT: String(port), TAU_PORT: String(httpsPort), TAU_USER: "switch-test", TAU_PASS: "switch-test-secret" },
    };
    // Match a Tau child originally started outside Herdr. In particular, the
    // CLI treats an empty socket variable as invalid rather than as "default".
    const inheritedSocket = process.env.HERDR_SOCKET_PATH;
    process.env.HERDR_SOCKET_PATH = "";
    try { await prepareHerdrSwitch(source); }
    finally { process.env.HERDR_SOCKET_PATH = inheritedSocket; }
    const prepared = await prepareHerdrSwitch(source, endpoint);
    const location = await prepared.start();
    const workspace = /workspace ([^,]+)/.exec(location)?.[1];
    assert.ok(workspace); workspaces.add(workspace);
    await until(() => trace().some((entry) => entry.event === "start" && entry.host === "herdr" && entry.file === sessionFile), "initial Herdr runtime");
    const first = trace().find((entry) => entry.event === "start" && entry.host === "herdr" && entry.file === sessionFile)!;
    await terminalRequest(first.control, { kind: "prompt", text: `/switch-smoke-branch ${selected}` });
    await until(() => trace().some((entry) => entry.event === "branched"), "non-tip branch navigation");
    assert.ok(!fs.existsSync(publication), "starting Herdr did not start Tau");
    assert.deepEqual(lines(opened), [], "no browser opens before transfer");
    const after = async (index: number, match: (entry: Trace) => boolean, message: string, timeout?: number): Promise<Trace> => {
      await until(() => trace().slice(index).some(match), message, timeout);
      return trace().slice(index).findLast(match)!;
    };
    let mark = trace().length;
    await terminalRequest(first.control, { kind: "prompt", text: "/switch tau" });
    await until(() => fs.existsSync(publication), "automatic Tau publication", 75_000);
    const initialRecord = serverRecord();
    ({ base, headers } = parseWebEndpoint(initialRecord.endpoint));
    assert.equal(new URL(base).hostname, "127.0.0.1", "wildcard server publishes a loopback orchestration endpoint");
    assert.equal(new URL(base).port, String(port));
    assert.deepEqual(lines(launches), [String(initialRecord.pid)], "exactly one local fork server was launched");
    // Default host is the wildcard address: every local IPv4 interface serves
    // Tau over HTTPS, is advertised without credentials, and still requires
    // authentication. Plain HTTP stays on loopback.
    const browserUrls = initialRecord.browserUrls ?? [];
    assert.ok(!browserUrls.some((url) => /switch-test|secret|@/.test(url)), "browser URLs carry no credentials");
    const external = Object.values(os.networkInterfaces()).flatMap((entries) => entries ?? [])
      .find((entry) => !entry.internal && entry.family === "IPv4")?.address;
    if (external) {
      const url = `https://${external}:${httpsPort}`;
      assert.ok(browserUrls.includes(url), `discovery advertises ${url}`);
      const ca = fs.readFileSync(path.join(agentDir, "tau", "tls", "ca.crt"));
      const status = (requestHeaders: Record<string, string>) => new Promise<number>((resolve, reject) => {
        https.get(`${url}/api/live-sessions`, { ca, headers: requestHeaders, timeout: 30_000 }, (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        }).on("error", reject);
      });
      assert.equal(await status({}), 401, "non-loopback access requires authentication");
      assert.equal(await status(headers), 200, "non-loopback access works with the configured credentials and generated CA");
      await assert.rejects(fetch(`http://${external}:${port}/api/live-sessions`, { signal: AbortSignal.timeout(30_000) }),
        "plain HTTP is not reachable from the network");
    } else t.diagnostic("No non-internal IPv4 interface; skipped external bind check");
    await until(async () => (await sessions()).some((entry) => entry.sessionFile === sessionFile), "Tau destination readiness", 75_000);
    const live = (await sessions()).find((entry) => entry.sessionFile === sessionFile)!;
    // The source reloads the same file in place and stays usable.
    const reopened = await after(mark, (entry) => entry.event === "start" && entry.pid === first.pid, "source reloads its same session");
    assert.equal(reopened.file, sessionFile);
    assert.ok(reopened.branch.includes(selected), "source keeps the selected branch visible");
    await until(() => lines(opened).length === 1, "browser opener after confirmed handoff");
    assert.deepEqual(lines(opened), [`${base}/#session=${encodeURIComponent(live.id)}`]);
    assert.ok(!stopped(first.pid), "source Herdr Pi stays open");
    await terminalRequest(first.control, { kind: "ping", sessionFile });
    const screen = async (pane: string): Promise<string> => (await exec(process.env.HERDR_BIN_PATH || "herdr",
      ["pane", "read", pane, "--source", "visible"], { env: { ...process.env, HERDR_SOCKET_PATH: endpoint }, timeout: 30_000 })).stdout;
    await until(async () => (await screen(first.pane)).includes("Session open in Tau tab"), "source shows its switch widget");
    const shown = await screen(first.pane);
    assert.match(shown, /\/resume/, "widget explains refreshing with /resume");
    assert.doesNotMatch(shown, /switch-test-secret/);
    mark = trace().length;
    await request("/api/rpc", { type: "prompt", sessionId: live.id, message: "/switch-smoke-state" });
    const middle = await after(mark, (entry) => entry.event === "state" && entry.host === "web", "Tau state report");
    mark = trace().length;
    await request("/api/rpc", { type: "prompt", sessionId: live.id, message: "/switch herdr" });
    const last = await after(mark, (entry) => entry.event === "start" && entry.host === "herdr" && entry.file === sessionFile, "return Herdr startup", 75_000);
    workspaces.add(last.workspace);
    assert.notEqual(last.pid, first.pid);
    await after(mark, (entry) => entry.event === "start" && entry.pid === middle.pid, "Tau source reloads its same session");
    assert.ok(!stopped(middle.pid), "Tau source Pi stays open");
    assert.deepEqual((await sessions()).filter((entry) => entry.sessionFile === sessionFile).map((entry) => entry.id), [live.id], "Tau keeps its tab");
    await terminalRequest(last.control, { kind: "ping", sessionFile });
    mark = trace().length;
    await terminalRequest(last.control, { kind: "prompt", text: "/switch-smoke-state" });
    const returned = await after(mark, (entry) => entry.event === "state" && entry.pid === last.pid, "return Herdr state report");
    // History written only in Herdr must appear in the retained Tau tab.
    await terminalRequest(last.control, { kind: "prompt", text: "/switch-smoke-mark written-in-herdr" });
    const marked = await after(mark, (entry) => entry.event === "marked" && entry.pid === last.pid, "Herdr writes history");
    const written = marked.branch.at(-1)!;
    assert.ok(!middle.branch.includes(written));
    const released = fs.readFileSync(sessionFile, "utf8");
    await terminalRequest(last.control, { kind: "prompt", text: "/switch tau" });
    await until(() => lines(opened).length === 2, "second browser opener after refresh", 75_000);
    assert.deepEqual(lines(opened), Array(2).fill(`${base}/#session=${encodeURIComponent(live.id)}`), "refresh reuses the same Tau tab");
    assert.deepEqual((await sessions()).filter((entry) => entry.sessionFile === sessionFile).map((entry) => entry.id), [live.id], "no duplicate Tau tab");
    assert.equal(serverRecord().pid, initialRecord.pid, "second transfer reuses the original server");
    assert.deepEqual(lines(launches), [String(initialRecord.pid)], "reuse does not invoke the Tau CLI again");
    assert.ok(!stopped(last.pid) && !stopped(first.pid) && !stopped(middle.pid), "every view stays open");
    mark = trace().length;
    await request("/api/rpc", { type: "prompt", sessionId: live.id, message: "/switch-smoke-state" });
    const final = await after(mark, (entry) => entry.event === "state" && entry.host === "web", "refreshed Tau state report");
    assert.equal(final.pid, middle.pid, "the same Tau child reloaded the file");
    assert.ok(final.branch.includes(written), "Tau shows history written in Herdr after refresh");
    for (const state of [middle, returned, final]) {
      assert.equal(state.file, sessionFile); assert.equal(state.sessionId, seed.getSessionId());
      assert.equal(state.cwd, directory); assert.equal(state.provider, "switch-native-fixture");
      assert.equal(state.model, "one"); assert.equal(state.thinking, "high");
      assert.deepEqual(state.tools, ["read"]);
      assert.ok(state.branch.includes(selected)); assert.ok(!state.branch.includes(abandoned));
    }
    assert.ok(fs.readFileSync(sessionFile, "utf8").startsWith(released), "transfer appends state, never rewrites prior transcript");
    assert.ok(!trace().some((entry) => entry.event === "unexpected-inference"));
    t.diagnostic("Passed automatic wildcard Tau startup and refresh across Herdr→Tau→Herdr→Tau: same file/id/branch/tools/model/cwd, every source stays open, retained Tau tab shows Herdr-written history, authenticated external URL, fake browser links, no inference.");
  } catch (error) {
    t.diagnostic(`Fixture trace: ${JSON.stringify(trace())}; launched server PIDs: ${lines(launches).join(", ")}`);
    throw error;
  } finally {
    // Only workspaces and server PIDs recorded by this test's own launchers.
    for (const entry of trace()) if (entry.host === "herdr" && entry.workspace) workspaces.add(entry.workspace);
    for (const workspace of workspaces) await herdr(["workspace", "close", workspace]).catch(() => {});
    for (const line of lines(launches)) {
      const pid = Number(line);
      assert.ok(Number.isSafeInteger(pid) && pid > 1, "invalid test-owned Tau PID");
      if (!stopped(pid)) process.kill(pid, "SIGTERM");
      await until(() => stopped(pid), "test-owned Tau server exits", 15_000);
    }
    for (const entry of trace()) if (entry.control) fs.rmSync(path.dirname(entry.control), { recursive: true, force: true });
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
