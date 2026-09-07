import * as net from "node:net";
import { fileURLToPath } from "node:url";

export const TERMINAL_INPUT_EXTENSION = fileURLToPath(new URL("./extensions/terminal-input.ts", import.meta.url));

/** Dispatch through Pi rather than pasting into an unknown human editor draft. */
export function terminalRequest(socketPath: string, request: { kind: "ping" } | { kind: "prompt"; text: string }, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let response = "";
    const abort = (): void => { socket.destroy(new Error("Terminal input cancelled")); };
    signal?.addEventListener("abort", abort, { once: true });
    socket.setEncoding("utf8");
    socket.setTimeout(30_000, () => socket.destroy(new Error(`Terminal input timeout: ${socketPath}`)));
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk: string) => { response += chunk; });
    socket.on("error", reject);
    socket.on("close", () => signal?.removeEventListener("abort", abort));
    socket.on("end", () => {
      try {
        const result: unknown = JSON.parse(response);
        if (typeof result !== "object" || result === null || !("dispatched" in result) || result.dispatched !== true) {
          throw new Error(`Terminal input was not dispatched: ${response}`);
        }
        resolve();
      } catch (error) { reject(error); }
    });
  });
}
