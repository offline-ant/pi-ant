import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { localTauConnection, findTauServer } from "./tau-server.ts";
import { availableHosts } from "./host.ts";
import { herdrCommand } from "./switch-destinations.ts";
import type { SessionTransfer } from "./session-transfer.ts";

export interface TakeDescription {
  sessionFile: string | null;
  cwd: string;
  agentDir: string;
  frontend: "herdr" | "tau";
  name: string;
}
export type TakeRequest = { kind: "describe" }
  | { kind: "take"; sessionFile: string; receiver: string; receiverSession: string | null }
  | { kind: "load"; source: string; receiverSession: string | null; transfer: SessionTransfer };
export interface TakeCandidate extends TakeDescription { socket: string; label: string }
export type TakeReply = (data: unknown, error?: string) => Promise<void>;

const directory = path.join(os.tmpdir(), `pi-session-take-${process.getuid?.() ?? "local"}`);

/** Deterministic addresses, not an ownership registry. Herdr already lists panes. */
export function takeSocket(identity: string): string {
  return path.join(directory, `${createHash("sha256").update(identity).digest("hex").slice(0, 24)}.sock`);
}
export function ownTakeSocket(frontend: "herdr" | "tau", env: NodeJS.ProcessEnv): string {
  if (frontend === "tau") return takeSocket(`pid:${process.pid}`);
  if (!env.HERDR_SOCKET_PATH || !env.HERDR_PANE_ID) throw new Error("Herdr did not provide its socket and pane identity.");
  return takeSocket(`herdr:${env.HERDR_SOCKET_PATH}:${env.HERDR_PANE_ID}`);
}

export function requestTake<T>(socketPath: string, request: TakeRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let response = "";
    socket.setEncoding("utf8");
    // Discovery is read-only and bounded. A transfer instead follows its peer's
    // connection lifetime: an outer deadline must not expire before a nested
    // load succeeds and make a completed takeover appear to have failed.
    if (request.kind === "describe") socket.setTimeout(5_000, () => socket.destroy(new Error("Session discovery timed out.")));
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", chunk => { response += chunk; });
    socket.on("error", reject);
    socket.on("end", () => {
      try {
        const result = JSON.parse(response) as { data: T; error?: string };
        if (result.error) throw new Error(result.error);
        resolve(result.data);
      } catch (error) { reject(error); }
    });
    socket.on("close", () => reject(new Error("Session takeover connection closed before confirmation.")));
  });
}

export async function listenTake(socketPath: string, dispatch: (request: TakeRequest, reply: TakeReply) => void): Promise<net.Server> {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const server = net.createServer(client => {
    client.on("error", () => {});
    client.setEncoding("utf8");
    let input = "";
    client.on("data", (chunk: string) => {
      input += chunk;
      const end = input.indexOf("\n");
      if (end < 0) return;
      client.removeAllListeners("data");
      const reply: TakeReply = (data, error) => new Promise((resolve, reject) => {
        if (client.destroyed) { reject(new Error("Session takeover caller disconnected.")); return; }
        client.end(`${JSON.stringify(error ? { error } : { data })}\n`, (error?: Error | null) => error ? reject(error) : resolve());
      });
      try {
        const request = JSON.parse(input.slice(0, end)) as TakeRequest;
        if (!request || !["describe", "take", "load"].includes(request.kind)) throw new Error("Unknown session takeover request.");
        dispatch(request, reply);
      } catch (error) { void reply(undefined, String(error)).catch(() => {}); }
    });
  });
  const listen = () => new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => { server.off("error", reject); fs.chmodSync(socketPath, 0o600); resolve(); });
  });
  try { await listen(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    const previous = fs.lstatSync(socketPath);
    // A crash leaves the pathname behind. Never unlink a listening peer or a
    // pathname replaced while we were checking the crashed listener.
    await new Promise<void>((resolve, reject) => {
      const probe = net.createConnection(socketPath);
      probe.once("connect", () => { probe.destroy(); reject(error); });
      probe.once("error", (failure: NodeJS.ErrnoException) => failure.code === "ECONNREFUSED" ? resolve() : reject(failure));
    });
    const current = fs.lstatSync(socketPath);
    if (!previous.isSocket() || previous.ino !== current.ino || previous.dev !== current.dev) throw error;
    fs.unlinkSync(socketPath);
    await listen();
  }
  return server;
}

export async function listTakeCandidates(kind: "herdr" | "tau", environment: NodeJS.ProcessEnv): Promise<TakeCandidate[]> {
  const addresses: { socket: string; label: string; file: string }[] = [];
  if (kind === "herdr") {
    const endpoint = availableHosts(environment).find(host => host.kind === "herdr")?.endpoint || environment.HERDR_SOCKET_PATH || undefined;
    const status = JSON.parse(await herdrCommand(endpoint, environment)(["status", "--json"])) as { server: { socket: string; running: boolean } };
    if (!status.server.running) throw new Error("Herdr is not running.");
    const listing = await herdrCommand(status.server.socket, environment)(["agent", "list"]);
    const { result } = JSON.parse(listing) as { result: { agents: { agent_session?: { agent: string; kind: string; value: string }; pane_id: string; title?: string; name?: string }[] } };
    for (const agent of result.agents) {
      if (agent.agent_session?.agent !== "pi" || agent.agent_session.kind !== "path") continue;
      addresses.push({ socket: takeSocket(`herdr:${status.server.socket}:${agent.pane_id}`), label: `${agent.pane_id} — ${agent.title || agent.name || "Pi"}`, file: agent.agent_session.value });
    }
  } else {
    const server = await findTauServer(environment);
    if (!server) throw new Error("Tau is not running.");
    const connection = localTauConnection(server.endpoint);
    const response = await fetch(`${connection.base}/api/live-sessions`, { headers: connection.headers, redirect: "error", signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error("Cannot list Tau sessions; check authentication.");
    const listing = await response.json() as { sessions: { id: string; pid: number; sessionFile: string; sessionName?: string }[] };
    for (const session of listing.sessions) {
      if (session.sessionFile) addresses.push({ socket: takeSocket(`pid:${session.pid}`), label: `${session.sessionName || "Pi"} (${session.id})`, file: session.sessionFile });
    }
  }
  const candidates = await Promise.all(addresses.map(async address => {
    try {
      const description = await requestTake<TakeDescription>(address.socket, { kind: "describe" });
      if (!description.sessionFile || path.resolve(description.sessionFile) !== path.resolve(address.file) || description.frontend !== kind) return null;
      return { ...description, socket: address.socket, label: `${address.label} — ${description.cwd}` };
    } catch { return null; } // Old, busy and managed sessions are deliberately not selectable.
  }));
  return candidates.filter((candidate): candidate is TakeCandidate => candidate !== null);
}
