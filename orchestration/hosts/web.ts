/*
 * Web host: a tau server (../../../tau) owning `pi --mode rpc` children.
 *
 * Unlike the terminal hosts there is no pane, no human draft, and no control
 * socket: prompts are RPC commands, so submission is draft-safe by
 * construction. Output is the child's structured entry list rendered to text,
 * not a terminal snapshot, and there is no shell, so panels stay on a terminal
 * host.
 */

import type { Host, HostTarget } from "../host-types.ts";

const REQUEST_TIMEOUT_MS = 30_000;

interface Connection {
  base: string;
  headers: Record<string, string>;
}

/** The endpoint is a URL; HTTP Basic credentials live in its userinfo. */
export function parseWebEndpoint(endpoint: string): Connection {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error(`The web orchestration endpoint must be a URL, not '${endpoint}'.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`The web orchestration endpoint must use http or https, not '${url.protocol}'.`);
  }
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (url.username) {
    const credentials = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
    headers.Authorization = `Basic ${Buffer.from(credentials).toString("base64")}`;
  }
  url.username = "";
  url.password = "";
  return { base: url.origin, headers };
}

interface SessionMetadata {
  id: string;
  sessionFile?: string | null;
}
interface EntryMessage {
  role?: string;
  content?: unknown;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

/** `undefined` for 404, so callers can distinguish a closed session from a failure. */
async function request(
  connection: Connection,
  method: string,
  path: string,
  body: unknown,
  signal: AbortSignal | undefined,
): Promise<Record<string, unknown> | undefined> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${connection.base}${path}`, {
      method,
      headers: connection.headers,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (error) {
    signal?.throwIfAborted();
    throw new Error(`Could not reach the web host at ${connection.base}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (response.status === 404) return undefined;
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`The web host at ${connection.base} answered ${method} ${path} with non-JSON content (status ${response.status}).`);
  }
  const data = record(parsed);
  if (!response.ok) {
    const detail = typeof data.error === "string" ? data.error : `status ${response.status}`;
    throw new Error(`Web host ${method} ${path} failed: ${detail}${response.status === 401 ? " (check the endpoint credentials)" : ""}`);
  }
  return data;
}

function blockText(block: Record<string, unknown>): string | undefined {
  if (block.type === "text" && typeof block.text === "string") return block.text;
  if (block.type === "image") return "[image]";
  if (block.type === "toolCall") return `[tool ${String(block.name ?? "?")}]`;
  return undefined;
}

function messageText(message: EntryMessage): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content.map((block) => blockText(record(block))).filter((text): text is string => text !== undefined).join("\n");
}

/** Terminal hosts return a pane snapshot; here the equivalent is the transcript tail. */
export function renderEntries(entries: unknown[], lines: number): string {
  const rendered: string[] = [];
  for (const entry of entries) {
    const item = record(entry);
    if (item.type !== "message") continue;
    const message = record(item.message) as EntryMessage;
    const text = messageText(message).trim();
    if (!text) continue;
    rendered.push(`${message.role ?? "message"}: ${text}`);
  }
  return rendered.join("\n\n").split("\n").slice(-Math.max(1, lines)).join("\n");
}

export function createWebHost(endpoint: string): Host {
  const connection = parseWebEndpoint(endpoint);
  const sessionPath = (target: HostTarget) => `/api/live-sessions/${encodeURIComponent(target.id)}`;
  async function snapshot(target: HostTarget, signal?: AbortSignal): Promise<Record<string, unknown> | undefined> {
    return request(connection, "GET", `${sessionPath(target)}/snapshot`, undefined, signal);
  }
  const host: Host = {
    kind: "web", endpoint,
    // Sessions are a flat server-owned list: nothing to parent a new one to.
    parent: () => undefined,
    async start(spec, signal) {
      signal?.throwIfAborted();
      if (spec.kind === "shell") {
        throw new Error("The web host runs Pi sessions only; it has no terminal for shell panels. Select a terminal host with /orchestration-host to start panels.");
      }
      // The model comes from spec.args (--provider/--model/--thinking), so the
      // server's own model argument stays out of the command line.
      const created = await request(connection, "POST", "/api/live-sessions", {
        cwd: spec.cwd, sessionFile: spec.sessionFile, args: spec.args, env: spec.env ?? {},
      }, signal);
      const session = record(created?.session) as unknown as SessionMetadata;
      if (typeof session.id !== "string" || !session.id) throw new Error("The web host did not return a session identity.");
      const target: HostTarget = {
        host: "web", endpoint, id: session.id, name: spec.name, kind: "pi", sessionFile: spec.sessionFile,
      };
      try {
        signal?.throwIfAborted();
        if (spec.prompt) await host.send(target, { kind: "prompt", text: spec.prompt }, signal);
        return target;
      } catch (error) {
        await host.close(target).catch(() => undefined);
        throw error;
      }
    },
    async send(target, input, signal) {
      if (input.kind !== "prompt") {
        throw new Error("The web host has no terminal: it accepts Pi prompts, not typed text or key presses.");
      }
      // "steer" only applies while the child is streaming; an idle child takes
      // the prompt directly. Either way the human's own draft is untouched.
      const response = await request(connection, "POST", "/api/rpc", {
        sessionId: target.id, type: "prompt", message: input.text, streamingBehavior: "steer",
      }, signal);
      if (response === undefined) throw new Error(`Web session ${target.name} (${target.id}) no longer exists.`);
      if (response.success === false) {
        throw new Error(`Web host rejected the prompt for ${target.name}: ${String(response.error ?? "unknown error")}`);
      }
    },
    async read(target, lines = 80, signal) {
      const data = await snapshot(target, signal);
      if (data === undefined) throw new Error(`Web session ${target.name} (${target.id}) no longer exists.`);
      const entries = Array.isArray(data.entries) ? data.entries : [];
      return renderEntries(entries, lines);
    },
    // The server drops a session as soon as its child exits, so a vanished
    // session is reported as missing rather than as a distinguishable exit.
    async state(target, signal) {
      return await snapshot(target, signal) === undefined ? "missing" : "running";
    },
    async close(target, signal) {
      await request(connection, "DELETE", sessionPath(target), undefined, signal);
    },
  };
  return host;
}
