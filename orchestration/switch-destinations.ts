import { execFile, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { availableHosts } from "./host.ts";
import { ensureTauServer, localTauConnection, type TauServer } from "./tau-server.ts";
import { TERMINAL_INPUT_EXTENSION, terminalRequest } from "./terminal-input.ts";

export type SwitchDestination = "herdr" | "tau";
export interface SwitchSource {
  sessionFile: string;
  cwd: string;
  args: string[];
  env: Record<string, string>;
}
export interface PreparedSwitch {
  start(): Promise<string>;
}
const execute = promisify(execFile);

/** Explicit empty values override identities inherited from the destination host. */
export function switchEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  return {
    PI_CODING_AGENT_DIR: path.resolve(env.PI_CODING_AGENT_DIR || path.join(env.HOME || os.homedir(), ".pi", "agent")),
    PI_NESTED: "", PI_ORCHESTRATION_TARGET: "", PI_ORCHESTRATION_CONTROL: "",
    HERDR_ENV: "", HERDR_SOCKET_PATH: env.HERDR_SOCKET_PATH || "",
    HERDR_WORKSPACE_ID: "", HERDR_TAB_ID: "", HERDR_PANE_ID: "",
    TMUX: "", TMUX_PANE: "",
    ...(env.PI_CODING_AGENT_SESSION_DIR ? { PI_CODING_AGENT_SESSION_DIR: path.resolve(env.PI_CODING_AGENT_SESSION_DIR) } : {}),
  };
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid destination response");
  return value as Record<string, unknown>;
}

export async function prepareSwitch(kind: SwitchDestination, source: SwitchSource): Promise<PreparedSwitch> {
  if (kind === "herdr") {
    const endpoint = availableHosts(process.env).find((host) => host.kind === "herdr")?.endpoint || source.env.HERDR_SOCKET_PATH;
    return prepareHerdrSwitch(source, endpoint || undefined);
  }
  const server = await ensureTauServer({ ...process.env, ...source.env });
  return prepareTauSwitch(source, server.endpoint, openTauBrowser, server);
}

export async function openTauBrowser(url: string): Promise<void> {
  // Desktop openers may remain alive with the browser. Wait only for process
  // creation, without pipes, terminal ownership or a timer that kills it later.
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32.exe" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}

export async function prepareTauSwitch(
  source: SwitchSource, endpoint: string, open: (url: string) => Promise<void> = openTauBrowser, server?: TauServer,
): Promise<PreparedSwitch> {
  const connection = localTauConnection(endpoint);
  async function request(route: string, body?: unknown): Promise<{ response: Response; data: Record<string, unknown> }> {
    const response = await fetch(`${connection.base}${route}`, {
      method: body === undefined ? "GET" : "POST", headers: connection.headers,
      redirect: "error", signal: AbortSignal.timeout(120_000),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { response, data: object(await response.json()) };
  }
  let listing: Awaited<ReturnType<typeof request>>;
  try { listing = await request("/api/live-sessions"); }
  catch { throw new Error("Cannot reach the local Tau server."); }
  if (!listing.response.ok || !Array.isArray(listing.data.sessions)) throw new Error("Tau preflight failed; check its server and authentication.");
  return {
    async start() {
      let result: Awaited<ReturnType<typeof request>>;
      try {
        result = await request("/api/live-sessions/resume", {
          filePath: source.sessionFile, cwd: source.cwd, args: source.args, refresh: true,
          env: { ...source.env, PI_ORCHESTRATION_HOST: "web", PI_ORCHESTRATION_ENDPOINT: endpoint },
        });
      } catch {
        throw new Error("Tau did not confirm the switch. Inspect its live tabs before continuing.");
      }
      if (!result.response.ok) {
        // Do not display untrusted server errors: they may contain credential-bearing CLI arguments.
        throw new Error(`Tau rejected the switch (HTTP ${result.response.status}); check whether its tab is busy or has queued input.`);
      }
      if (result.data.started !== true && result.data.refreshed !== true) {
        throw new Error("Tau did not confirm a newly started or refreshed session. Inspect its live tabs before continuing.");
      }
      const session = object(result.data.session);
      if (typeof session.id !== "string" || typeof session.sessionFile !== "string"
        || path.resolve(session.sessionFile) !== source.sessionFile) {
        throw new Error("Tau returned an unconfirmed session identity. Inspect its live tabs before continuing.");
      }
      const hash = `session=${encodeURIComponent(session.id)}`;
      const url = `${connection.base}/#${hash}`;
      let browser = "";
      try { await open(url); }
      catch { browser = "\nBrowser could not be opened; open this URL manually."; }
      const addresses = (server?.browserUrls ?? []).map((address) => {
        const external = new URL(address);
        external.username = "";
        external.password = "";
        external.hash = hash;
        return external.href;
      }).filter((address) => address !== url);
      const remote = addresses.length ? `\nBrowser URLs: ${addresses.join("\n")}` : "";
      const service = server?.pid ? `\nTau server PID: ${server.pid}${server.logFile ? `; log: ${server.logFile}` : ""}. It runs independently of this panel.` : "";
      return `Tau tab ${session.id} at ${url}${remote}${service}${browser}`;
    },
  };
}

type HerdrCommand = (args: string[]) => Promise<string>;

function herdrCommand(endpoint?: string): HerdrCommand {
  const binary = process.env.HERDR_BIN_PATH || "herdr";
  const env = { ...process.env };
  // An empty HERDR_SOCKET_PATH is an invalid socket to the CLI, not its default.
  if (endpoint) env.HERDR_SOCKET_PATH = endpoint;
  else delete env.HERDR_SOCKET_PATH;
  return async (args) => {
    const { stdout } = await execute(binary, args, {
      env, timeout: 120_000, maxBuffer: 1024 * 1024,
    });
    return stdout;
  };
}

export async function prepareHerdrSwitch(source: SwitchSource, endpoint?: string, run?: HerdrCommand): Promise<PreparedSwitch> {
  // Status does not start a server or follow client focus. With no explicit
  // endpoint, let the CLI resolve its normal local socket, then pin that socket.
  let server: Record<string, unknown>;
  try { server = object(object(JSON.parse(await (run ?? herdrCommand(endpoint))(["status", "--json"]))).server); }
  catch { throw new Error("Cannot reach the local Herdr server."); }
  if (server.running !== true || typeof server.socket !== "string") throw new Error("No running local Herdr server. Start it first; /switch does not start Herdr.");
  const socket = endpoint || server.socket;
  if (!path.isAbsolute(socket) || !fs.statSync(socket).isSocket()) throw new Error("/switch requires a local Herdr socket.");
  const command = run ?? herdrCommand(socket);
  return {
    async start() {
      const name = `switch-${randomUUID().slice(0, 12)}`;
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-terminal-switch-"));
      const controlPath = path.join(directory, "input.sock");
      let workspace: string | undefined;
      try {
        const env: Record<string, string> = { ...source.env, PI_ORCHESTRATION_HOST: "herdr", PI_ORCHESTRATION_ENDPOINT: socket,
          HERDR_ENV: "1", HERDR_SOCKET_PATH: socket, PI_ORCHESTRATION_CONTROL: controlPath };
        // Herdr supplies the fresh workspace/pane identities itself.
        delete env.HERDR_WORKSPACE_ID;
        delete env.HERDR_TAB_ID;
        delete env.HERDR_PANE_ID;
        const args = ["workspace", "create", "--cwd", source.cwd, "--label", `Pi: ${path.basename(source.cwd) || source.cwd}`, "--no-focus"];
        for (const [key, value] of Object.entries(env)) args.push("--env", `${key}=${value}`);
        const created = object(object(JSON.parse(await command(args))).result);
        workspace = String(object(created.workspace).workspace_id || "");
        const pane = object(created.root_pane).pane_id;
        if (!workspace || typeof pane !== "string") throw new Error("Herdr did not return the new workspace/pane identity");
        const startDeadline = Date.now() + 5_000;
        while (true) {
          try {
            await command(["agent", "start", name, "--kind", "pi", "--pane", pane, "--", "--session", source.sessionFile,
              ...source.args, "-e", TERMINAL_INPUT_EXTENSION]);
            break;
          } catch (error) {
            const output = object(error);
            let busy = false;
            for (const raw of [output.stdout, output.stderr]) {
              if (typeof raw !== "string") continue;
              try { busy ||= object(object(JSON.parse(raw)).error).code === "agent_pane_busy"; }
              catch { /* Ordinary CLI diagnostics are not JSON. */ }
            }
            if (!busy || Date.now() >= startDeadline) throw error;
            await delay(100);
          }
        }
        const deadline = Date.now() + 30_000;
        while (true) {
          try { await terminalRequest(controlPath, { kind: "ping", sessionFile: source.sessionFile }); break; }
          catch {
            if (Date.now() >= deadline) throw new Error("Herdr session readiness timed out");
            await delay(50);
          }
        }
        return `Herdr workspace ${workspace}, pane ${pane}`;
      } catch {
        if (workspace) {
          try { await command(["workspace", "close", workspace]); }
          catch { throw new Error(`Herdr switch failed; inspect workspace ${workspace} before continuing.`); }
        }
        fs.rmSync(directory, { recursive: true, force: true });
        throw new Error("Herdr switch failed. No source pane was closed.");
      }
    },
  };
}
