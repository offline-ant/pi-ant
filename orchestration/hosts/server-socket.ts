import * as net from "node:net";
import * as path from "node:path";

const PROBE_TIMEOUT_MS = 2000;

/**
 * Whether no server listens on a local Unix socket: the path is absent or
 * connecting is refused. A host server owns its panes' and buffers' processes,
 * so its targets are gone with it, and a later server on the same path knows
 * none of them. Any other outcome (accepted, permission denied, timeout, or a
 * bare server name rather than a path) is not proof, so the caller keeps
 * reporting its original failure.
 */
export function serverGone(socket: string): Promise<boolean> {
  if (!path.isAbsolute(socket)) return Promise.resolve(false);
  return new Promise((resolve) => {
    const probe = net.connect(socket);
    const finish = (gone: boolean) => { probe.destroy(); resolve(gone); };
    probe.setTimeout(PROBE_TIMEOUT_MS, () => finish(false));
    probe.once("connect", () => finish(false));
    probe.once("error", (error: NodeJS.ErrnoException) => finish(error.code === "ENOENT" || error.code === "ECONNREFUSED"));
  });
}
