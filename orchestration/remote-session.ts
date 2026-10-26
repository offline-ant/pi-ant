import { posix } from "node:path";
import { remotePathWord, sshRun, validateDestination } from "./ssh.ts";

/** Environment variable naming the SSH target where a Pi process runs its tools. */
export const REMOTE_ENV = "PI_REMOTE";

/** `user@host[:path]`; without a path the remote home directory is used. */
export interface RemoteTarget {
  destination: string;
  path?: string;
}

/** A target resolved on the remote host: absolute working and home directories. */
export interface RemoteLocation {
  destination: string;
  cwd: string;
  home: string;
}

export function parseRemoteTarget(spec: string): RemoteTarget {
  const value = spec.trim();
  // Bracketed IPv6 hosts contain colons of their own.
  const hostEnd = value.startsWith("[") || value.includes("@[") ? value.indexOf("]") + 1 : 0;
  const separator = value.indexOf(":", hostEnd);
  const destination = separator === -1 ? value : value.slice(0, separator);
  const remotePath = separator === -1 ? undefined : value.slice(separator + 1);
  validateDestination(destination);
  if (remotePath && !(remotePath.startsWith("/") || remotePath === "~" || remotePath.startsWith("~/"))) {
    throw new Error(`Remote path in '${spec}' must be absolute or start with ~/ (user@host:/abs/path).`);
  }
  return remotePath === undefined || remotePath === "" ? { destination } : { destination, path: remotePath };
}

export function formatRemoteLocation(location: Pick<RemoteLocation, "destination" | "cwd">): string {
  return `${location.destination}:${location.cwd}`;
}

/**
 * Resolve a target on its host: `path` (else the remote home), then `folder`
 * relative to it. The returned directory exists; connection failures throw.
 */
export async function resolveRemoteLocation(target: RemoteTarget, folder?: string, signal?: AbortSignal): Promise<RemoteLocation> {
  const script = [
    "cd || exit 90",
    "home=$(pwd)",
    ...(target.path === undefined ? [] : [`cd -- ${remotePathWord(target.path)} || exit 91`]),
    ...(folder === undefined ? [] : [`cd -- ${remotePathWord(folder)} || exit 91`]),
    `printf '%s\\0%s\\0' "$home" "$(pwd)"`,
  ].join("\n");
  const result = await sshRun(target.destination, script, { signal });
  const requested = [target.path ?? "~", folder].filter((part) => part !== undefined).join(" + ");
  if (result.code === 90) throw new Error(`Remote home directory on ${target.destination} is unavailable: ${result.stderr.trim()}`);
  if (result.code !== 0) throw new Error(`Remote directory ${target.destination}:${requested} is not accessible: ${result.stderr.trim() || `exit status ${result.code}`}`);
  const [home, cwd] = result.stdout.toString().split("\0");
  if (!home?.startsWith("/") || !cwd?.startsWith("/")) throw new Error(`Unexpected directory output from ${target.destination}: ${JSON.stringify(result.stdout.toString())}`);
  return { destination: target.destination, cwd, home };
}

/** Expand a leading `~` in a tool path argument to the remote home; Pi would expand it locally. */
export function expandRemoteHome(value: string, home: string): string {
  if (value === "~") return home;
  if (value.startsWith("~/")) return posix.join(home, value.slice(2));
  return value;
}

/** The process's remote target, resolved once and retried after failures. */
export class RemoteSession {
  readonly spec: string;
  readonly target: RemoteTarget | undefined;
  readonly invalid: Error | undefined;
  private resolved: Promise<RemoteLocation> | undefined;

  constructor(spec: string) {
    this.spec = spec;
    try {
      this.target = parseRemoteTarget(spec);
    } catch (error) {
      this.invalid = error instanceof Error ? error : new Error(String(error));
    }
  }

  /** Never falls back to local execution: an invalid or unreachable target rejects. */
  location(signal?: AbortSignal): Promise<RemoteLocation> {
    if (this.invalid) return Promise.reject(new Error(`${REMOTE_ENV} is invalid: ${this.invalid.message}`));
    if (!this.resolved) {
      const pending = resolveRemoteLocation(this.target!);
      this.resolved = pending;
      // A later call reconnects instead of repeating a stale failure.
      pending.catch(() => { if (this.resolved === pending) this.resolved = undefined; });
    }
    const resolved = this.resolved;
    if (!signal) return resolved;
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(new Error("Operation aborted"));
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
      resolved.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
  }
}

const STATE = Symbol.for("pi-ant.orchestration.remote");

/** Frozen at first use per process, like the orchestration host selection. */
export function sessionRemote(): RemoteSession | undefined {
  const globals = globalThis as typeof globalThis & { [STATE]?: { session: RemoteSession | undefined } };
  if (!globals[STATE]) {
    const spec = process.env[REMOTE_ENV]?.trim();
    globals[STATE] = { session: spec ? new RemoteSession(spec) : undefined };
  }
  return globals[STATE].session;
}

/** Environment a Pi child needs to run its tools at `location`. */
export function remoteChildEnvironment(location: Pick<RemoteLocation, "destination" | "cwd">): Record<string, string> {
  return { [REMOTE_ENV]: formatRemoteLocation(location) };
}
