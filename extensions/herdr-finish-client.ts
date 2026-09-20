import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";

export type HerdrSubscription = { type: string; pane_id?: string };
export interface HerdrPane {
  pane_id: string;
  terminal_id: string;
  workspace_id: string;
  tab_id: string;
  agent?: string;
  agent_status: string;
  agent_session?: { value: string };
}

export class HerdrApiError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`Herdr: ${message}`);
    this.code = code;
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Herdr response");
  return value as Record<string, unknown>;
}

/** One request per connection; subscriptions retain their socket after the acknowledgement. */
export class HerdrFinishClient {
  private readonly endpoint: string;
  private readonly timeoutMs: number;

  constructor(endpoint: string, timeoutMs = 5_000) {
    this.endpoint = process.platform === "win32" ? `\\\\.\\pipe\\${endpoint}` : endpoint;
    this.timeoutMs = timeoutMs;
  }

  private open(
    method: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    events?: { changed: () => void; failed: (error: Error) => void },
  ): Promise<{ result: Record<string, unknown>; close: () => void }> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const socket = createConnection(this.endpoint);
      let buffer = "";
      let acknowledged = false;
      let closed = false;
      const timeout = setTimeout(() => fail(new Error(`Herdr ${method} timed out`)), this.timeoutMs);
      const close = () => {
        if (closed) return;
        closed = true;
        clearTimeout(timeout);
        signal.removeEventListener("abort", abort);
        socket.destroy();
      };
      const fail = (error: Error) => {
        if (closed) return;
        close();
        if (!acknowledged) reject(error);
        else events?.failed(error);
      };
      const abort = () => fail(signal.reason instanceof Error ? signal.reason : new Error("Herdr wait cancelled"));
      signal.addEventListener("abort", abort, { once: true });
      socket.setEncoding("utf8");
      socket.on("connect", () => socket.write(`${JSON.stringify({ id, method, params })}\n`));
      socket.on("error", fail);
      socket.on("close", () => fail(new Error("Herdr connection closed")));
      socket.on("data", (chunk: string) => {
        if (closed) return;
        buffer += chunk;
        try {
          let newline: number;
          while (!closed && (newline = buffer.indexOf("\n")) !== -1) {
            if (Buffer.byteLength(buffer.slice(0, newline)) > 4 * 1024 * 1024) throw new Error("Herdr response too large");
            const message = object(JSON.parse(buffer.slice(0, newline)));
            buffer = buffer.slice(newline + 1);
            if (message.error !== undefined) {
              const error = object(message.error);
              throw new HerdrApiError(String(error.code), String(error.message));
            }
            if (!acknowledged) {
              if (message.id !== id) throw new Error("Unexpected Herdr response ID");
              const result = object(message.result);
              if (events && result.type !== "subscription_started") throw new Error("Invalid Herdr subscription acknowledgement");
              acknowledged = true;
              clearTimeout(timeout);
              resolve({ result, close });
              if (!events) close();
            } else {
              if (typeof message.event !== "string") throw new Error("Invalid Herdr event");
              object(message.data);
              events?.changed();
            }
          }
          if (Buffer.byteLength(buffer) > 4 * 1024 * 1024) throw new Error("Herdr response too large");
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
  }

  async panes(signal: AbortSignal): Promise<HerdrPane[]> {
    const { result } = await this.open("pane.list", {}, signal);
    if (!Array.isArray(result.panes)) throw new Error("Invalid Herdr pane list");
    return result.panes.map((value) => {
      const pane = object(value);
      for (const key of ["pane_id", "terminal_id", "workspace_id", "tab_id", "agent_status"]) {
        if (typeof pane[key] !== "string" || !pane[key]) throw new Error(`Invalid Herdr pane ${key}`);
      }
      if (pane.agent !== undefined && typeof pane.agent !== "string") throw new Error("Invalid Herdr agent");
      if (pane.agent_session !== undefined && typeof object(pane.agent_session).value !== "string") {
        throw new Error("Invalid Herdr agent session");
      }
      return pane as unknown as HerdrPane;
    });
  }

  async subscribe(
    subscriptions: HerdrSubscription[],
    changed: () => void,
    failed: (error: Error) => void,
    signal: AbortSignal,
  ): Promise<() => void> {
    const { close } = await this.open("events.subscribe", { subscriptions }, signal, { changed, failed });
    return close;
  }
}
