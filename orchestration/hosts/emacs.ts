import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Host, HostTarget } from "../host-types.ts";
import { serverGone } from "./server-socket.ts";

const COMPANION = fileURLToPath(new URL("../emacs/pi-orchestration.el", import.meta.url));
const STARTUP_TIMEOUT_MS = 120_000;
const QUERY_TIMEOUT_MS = 10_000;
/** Killing a client mid-mutation can leave its work orphaned, so mutations may wait out a stall. */
const MUTATION_TIMEOUT_MS = 60_000;
const QUERY_OPERATIONS = new Set(["state", "response", "read", "switch-state"]);

interface EmacsReply {
  error?: string;
  target?: HostTarget;
  output?: string;
  state?: "running" | "exited" | "missing";
  ready?: boolean;
  pending?: boolean;
  success?: boolean;
}

/** Runs a command like `pi.exec`, resolving with its exit code instead of throwing; `killed` marks a timed-out or aborted command. */
export type EmacsExec = (command: string, args: string[], options: { signal?: AbortSignal; timeout: number; env?: NodeJS.ProcessEnv })
  => Promise<{ code: number; stdout: string; stderr: string; killed: boolean }>;

/** Emacs did not answer in time: it may be stalled, and says nothing about its targets. */
export class EmacsUnresponsiveError extends Error {
  constructor(endpoint: string, operation: unknown, timeout: number) {
    super(`Emacs ${endpoint} did not answer '${String(operation)}' within ${timeout / 1000} s; it may be busy.`);
    this.name = "EmacsUnresponsiveError";
  }
}

/** A poll's reply, or undefined while Emacs is too busy to answer; pollers keep their own deadline. */
export async function emacsPoll<T>(query: () => Promise<T>): Promise<T | undefined> {
  try { return await query(); }
  catch (error) {
    if (error instanceof EmacsUnresponsiveError) return undefined;
    throw error;
  }
}

/** One base64-JSON companion operation through emacsclient; never Lisp built from data. */
export async function emacsOperation(
  exec: EmacsExec, endpoint: string, data: Record<string, unknown>, signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  signal?.throwIfAborted();
  const encoded = Buffer.from(JSON.stringify(data), "utf8").toString("base64");
  const expression = `(progn (require 'pi-orchestration ${JSON.stringify(COMPANION)}) (pi-orchestration-dispatch "${encoded}"))`;
  const timeout = QUERY_OPERATIONS.has(String(data.operation)) ? QUERY_TIMEOUT_MS : MUTATION_TIMEOUT_MS;
  const result = await exec("emacsclient", ["--socket-name", endpoint, "--eval", expression], { signal, timeout });
  signal?.throwIfAborted();
  if (result.killed) throw new EmacsUnresponsiveError(endpoint, data.operation, timeout);
  if (result.code !== 0) {
    throw new Error(`Emacs ${endpoint}: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  // The only Lisp return value is an ASCII base64 string, so its printed form
  // is also a JSON string. Task text is never interpreted as Lisp source.
  const encodedReply: unknown = JSON.parse(result.stdout.trim());
  if (typeof encodedReply !== "string") throw new Error("Invalid Emacs operation response");
  const reply = JSON.parse(Buffer.from(encodedReply, "base64").toString("utf8")) as Record<string, unknown>;
  if (typeof reply.error === "string" && reply.error) throw new Error(`Emacs ${endpoint}: ${reply.error}`);
  return reply;
}

/** Emacs owns native buffers/processes; all waits stay outside its command loop. */
export function createEmacsHost(pi: ExtensionAPI, endpoint: string): Host {
  async function call(data: Record<string, unknown>, signal?: AbortSignal): Promise<EmacsReply> {
    return await emacsOperation((command, args, { signal, timeout }) => pi.exec(command, args, { signal, timeout }), endpoint, data, signal) as EmacsReply;
  }

  async function waitForAcceptance(target: HostTarget, request: string, signal?: AbortSignal): Promise<void> {
    while (true) {
      const reply = await emacsPoll(() => call({ operation: "response", id: target.id, request }, signal));
      if (reply && !reply.pending) {
        if (!reply.success) throw new Error(`Emacs target ${target.name} rejected prompt`);
        return;
      }
      // Extension commands may await settlement (for example /worker-return).
      // A readiness deadline must not become an arbitrary task deadline.
      await delay(50, undefined, { signal });
    }
  }

  /** The daemon owns every target's buffers and processes; none outlive it. */
  async function goneWithServer(error: unknown): Promise<true> {
    if (await serverGone(endpoint)) return true;
    throw error;
  }

  async function closeTarget(id: string): Promise<void> {
    const deadline = Date.now() + 5000;
    for (;;) {
      let reply: EmacsReply;
      try { reply = await call({ operation: "close", id, force: Date.now() >= deadline }); }
      catch (error) { await goneWithServer(error); return; }
      if (!reply.pending) return;
      await delay(50);
    }
  }

  const host: Host = {
    kind: "emacs",
    endpoint,
    parent() {
      const id = process.env.PI_ORCHESTRATION_TARGET;
      return id ? { host: "emacs", endpoint, id, name: id, kind: "pi" } : undefined;
    },
    async start(spec, signal) {
      const id = randomUUID();
      let target: HostTarget | undefined;
      try {
        const reply = await call({ operation: "start", id, endpoint, spec }, signal);
        target = reply.target;
        if (!target) throw new Error("Emacs start returned no target");
        if (spec.kind === "pi") {
          const deadline = Date.now() + STARTUP_TIMEOUT_MS;
          while (true) {
            const state = await emacsPoll(() => call({ operation: "state", id }, signal));
            if (state?.ready) break;
            if (state && state.state !== "running") throw new Error(`Emacs Pi exited during startup: ${spec.name} (${id})`);
            if (Date.now() >= deadline) throw new Error(`Emacs Pi startup timed out: ${spec.name} (${id})`);
            await delay(50, undefined, { signal });
          }
          if (spec.prompt) await host.send(target, { kind: "prompt", text: spec.prompt }, signal);
        }
        return target;
      } catch (error) {
        // Creation may have completed even if emacsclient was cancelled before
        // returning its handle. The preassigned ID identifies only our target.
        await closeTarget(id).catch(() => undefined);
        throw error;
      }
    },
    async send(target, input, signal) {
      const request = randomUUID();
      const reply = await call({ operation: "send", id: target.id, input, request }, signal);
      if (reply.pending) await waitForAcceptance(target, request, signal);
    },
    async read(target, lines = 80, signal) {
      const reply = await call({ operation: "read", id: target.id, lines }, signal);
      return reply.output ?? "";
    },
    async state(target, signal) {
      let reply: EmacsReply;
      try { reply = await call({ operation: "state", id: target.id }, signal); }
      catch (error) {
        signal?.throwIfAborted();
        await goneWithServer(error);
        return "missing";
      }
      return reply.state ?? "missing";
    },
    async close(target, signal) {
      signal?.throwIfAborted();
      // Finish owned cleanup once it starts, even if the caller is cancelled.
      await closeTarget(target.id);
    },
  };
  return host;
}
