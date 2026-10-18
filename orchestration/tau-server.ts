import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseWebEndpoint } from "./hosts/web.ts";

export interface TauServer {
  endpoint: string;
  pid?: number;
  logFile?: string;
  browserUrls?: string[];
  started: boolean;
}
interface Publication { endpoint: string; pid: number; browserUrls?: string[] }
interface StartupTiming {
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
  stopTimeoutMs?: number;
}

function localHosts(): Set<string> {
  const addresses = Object.values(os.networkInterfaces()).flatMap((entries) => entries ?? []).map((entry) => entry.address);
  return new Set(["localhost", "127.0.0.1", "[::1]", ...addresses.filter((address) => !address.includes("%")).map((address) =>
    new URL(`http://${address.includes(":") ? `[${address}]` : address}`).hostname)]);
}

/** Validate before parsing: neither parser failures nor displayed URLs may expose credentials. */
export function localTauConnection(endpoint: string): ReturnType<typeof parseWebEndpoint> {
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new Error("Invalid Tau endpoint."); }
  if (!["http:", "https:"].includes(url.protocol) || !localHosts().has(url.hostname)) {
    throw new Error("/switch requires a local Tau server sharing this machine's session files.");
  }
  try { return parseWebEndpoint(endpoint); }
  catch { throw new Error("Invalid Tau endpoint credentials."); }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
    throw new Error("Cannot establish whether the recorded Tau process is running.");
  }
}

function publication(file: string): Publication | undefined {
  let text: string;
  try { text = fs.readFileSync(file, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`Cannot read Tau discovery at ${file}; refusing to start a replacement.`);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { /* Report without printing the private contents. */ }
  if (typeof parsed !== "object" || parsed === null || !("endpoint" in parsed) || typeof parsed.endpoint !== "string"
    || !("pid" in parsed) || !Number.isSafeInteger(parsed.pid) || Number(parsed.pid) <= 0) {
    throw new Error(`Malformed Tau discovery at ${file}; inspect it before starting another server.`);
  }
  let browserUrls: string[] | undefined;
  if ("browserUrls" in parsed) {
    try {
      if (!Array.isArray(parsed.browserUrls)) throw new Error();
      const endpoint = new URL(parsed.endpoint);
      const hosts = localHosts();
      browserUrls = [...new Set(parsed.browserUrls.map((value: unknown) => {
        if (typeof value !== "string") throw new Error();
        const url = new URL(value);
        if (url.protocol !== "http:" || endpoint.protocol !== url.protocol || url.port !== endpoint.port
          || !hosts.has(url.hostname) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error();
        return url.origin;
      }))];
    } catch { throw new Error(`Malformed Tau browser URLs at ${file}; inspect discovery before retrying.`); }
  }
  return { endpoint: parsed.endpoint, pid: Number(parsed.pid), ...(browserUrls ? { browserUrls } : {}) };
}

async function probe(endpoint: string, timeoutMs: number): Promise<void> {
  const connection = localTauConnection(endpoint);
  let response: Response;
  try {
    response = await fetch(`${connection.base}/api/live-sessions`, {
      headers: connection.headers, redirect: "error", signal: AbortSignal.timeout(timeoutMs),
    });
  } catch { throw new Error("Cannot reach the recorded Tau server; it was not restarted or replaced."); }
  if (!response.ok) throw new Error(`Tau readiness failed (HTTP ${response.status}); check the server and its authentication.`);
  let data: unknown;
  try { data = await response.json(); } catch { /* Do not print an untrusted response. */ }
  if (typeof data !== "object" || data === null || !("sessions" in data) || !Array.isArray(data.sessions)) {
    throw new Error("Tau readiness returned an invalid session listing.");
  }
}

/** Start only on explicit request, never during extension discovery. Ready servers become shared. */
export async function ensureTauServer(env: NodeJS.ProcessEnv = process.env, timing: StartupTiming = {}): Promise<TauServer> {
  const startupTimeoutMs = timing.startupTimeoutMs ?? 30_000;
  const requestTimeoutMs = timing.requestTimeoutMs ?? 5_000;
  const stopTimeoutMs = timing.stopTimeoutMs ?? 5_000;
  const agentDir = path.resolve(env.PI_CODING_AGENT_DIR || path.join(env.HOME || os.homedir(), ".pi", "agent"));
  const directory = path.join(agentDir, "tau");
  const runtimeFile = path.join(directory, "server.json");
  const logFile = path.join(directory, "server.log");
  const explicit = env.PI_ORCHESTRATION_HOST?.trim() === "web" ? env.PI_ORCHESTRATION_ENDPOINT : undefined;
  if (env.PI_ORCHESTRATION_HOST?.trim() === "web") {
    if (!explicit) throw new Error("Explicit web orchestration requires PI_ORCHESTRATION_ENDPOINT; no Tau server was started.");
    await probe(explicit, requestTimeoutMs);
    return { endpoint: explicit, started: false };
  }
  const reuse = async (): Promise<TauServer | undefined> => {
    const record = publication(runtimeFile);
    if (!record || !alive(record.pid)) return undefined;
    await probe(record.endpoint, requestTimeoutMs);
    return { ...record, started: false, ...(fs.existsSync(logFile) ? { logFile } : {}) };
  };
  const existing = await reuse();
  if (existing) return existing;

  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  // The short claim serializes discovery + startup, not sessions or server lifetime.
  // An interrupted claim is never removed based on age or an unverified owner.
  const claim = path.join(directory, "startup.lock");
  const deadline = Date.now() + startupTimeoutMs;
  while (true) {
    try {
      const fd = fs.openSync(claim, "wx", 0o600);
      try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid })); }
      finally { fs.closeSync(fd); }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new Error(`Cannot claim Tau startup at ${claim}.`);
      let owner: unknown;
      try { owner = JSON.parse(fs.readFileSync(claim, "utf8")); } catch { /* The creator may still be writing. */ }
      if (typeof owner === "object" && owner !== null && "pid" in owner && Number.isSafeInteger(owner.pid) && Number(owner.pid) > 0
        && !alive(Number(owner.pid))) {
        throw new Error(`Tau startup was interrupted. Its owner stopped; inspect and remove only ${claim} before retrying.`);
      }
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for Tau startup; inspect ${claim}.`);
      await delay(50);
    }
  }
  try {
    const ready = await reuse(); // Another caller may have completed startup while we waited.
    if (ready) return ready;
    const childEnv: NodeJS.ProcessEnv = { ...env, PI_CODING_AGENT_DIR: agentDir };
    if (childEnv.PI_CODING_AGENT_SESSION_DIR) childEnv.PI_CODING_AGENT_SESSION_DIR = path.resolve(childEnv.PI_CODING_AGENT_SESSION_DIR);
    for (const key of ["PI_NESTED", "PI_ORCHESTRATION_HOST", "PI_ORCHESTRATION_ENDPOINT", "PI_ORCHESTRATION_CONTROL", "PI_ORCHESTRATION_TARGET",
      "HERDR_ENV", "HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID", "TMUX", "TMUX_PANE"]) delete childEnv[key];
    const fd = fs.openSync(logFile, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW, 0o600);
    let child: ChildProcess;
    try {
      fs.fchmodSync(fd, 0o600);
      child = spawn("pi-tau-web-server", [], {
        cwd: agentDir, env: childEnv, detached: true, stdio: ["ignore", fd, fd],
      });
    } finally { fs.closeSync(fd); }
    let closed = false;
    let failed = false;
    const exited = new Promise<void>((resolve) => child.once("close", () => { closed = true; resolve(); }));
    child.on("error", () => { failed = true; });
    const waitForExit = async () => {
      let timer: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([exited.then(() => true), new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), stopTimeoutMs); })]);
      } finally { clearTimeout(timer); }
    };
    const stop = async () => {
      if (closed) return;
      try { child.kill("SIGTERM"); } catch { /* Actual exit, not signal delivery, decides cleanup. */ }
      if (await waitForExit()) return;
      try { child.kill("SIGKILL"); } catch { /* Report uncertainty if the process still does not exit. */ }
      if (!await waitForExit()) throw new Error(`Tau startup failed and child exit is unconfirmed (PID ${child.pid ?? "unknown"}). Inspect ${logFile}.`);
    };
    try {
      while (true) {
        if (closed || failed) throw new Error(`Could not start pi-tau-web-server from PATH. Check its installation and ${logFile}.`);
        const record = publication(runtimeFile);
        if (record && alive(record.pid)) {
          if (record.pid !== child.pid) {
            // A manually started server won publication. Never stop or replace it.
            await stop();
            await probe(record.endpoint, requestTimeoutMs);
            return { ...record, started: false };
          }
          await probe(record.endpoint, Math.max(1, Math.min(requestTimeoutMs, deadline - Date.now())));
          if (closed || failed) throw new Error(`Tau exited during readiness; inspect ${logFile}.`);
          child.unref();
          return { ...record, logFile, started: true };
        }
        if (Date.now() >= deadline) throw new Error(`Tau startup timed out; inspect ${logFile}.`);
        await delay(50);
      }
    } catch (error) {
      await stop();
      throw error;
    }
  } finally { fs.unlinkSync(claim); }
}
