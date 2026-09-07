import * as fs from "node:fs";
import * as net from "node:net";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Native terminal submissions append to drafts. Keep machine prompts out of the human editor. */
export default function terminalInput(pi: ExtensionAPI): void {
  const socketPath = process.env.PI_ORCHESTRATION_CONTROL;
  if (!socketPath) return;
  let server: net.Server | undefined;
  const clients = new Set<net.Socket>();

  pi.on("session_start", async () => {
    server = net.createServer((client) => {
      clients.add(client);
      client.on("close", () => clients.delete(client));
      client.on("error", () => client.destroy());
      client.setEncoding("utf8");
      let input = "";
      client.on("data", (chunk: string) => {
        input += chunk;
        const newline = input.indexOf("\n");
        if (newline < 0) return;
        client.removeAllListeners("data");
        try {
          const request: unknown = JSON.parse(input.slice(0, newline));
          if (typeof request !== "object" || request === null || !("kind" in request)) {
            throw new Error("Expected a terminal-input request");
          }
          if (request.kind === "prompt" && "text" in request && typeof request.text === "string") {
            pi.sendUserMessage(request.text, { deliverAs: "followUp", expandPromptTemplates: true });
          } else if (request.kind !== "ping") {
            throw new Error("Expected ping or prompt with text");
          }
          // Dispatch acknowledgement only; worker result artifacts determine completion.
          client.end(`${JSON.stringify({ dispatched: true })}\n`);
        } catch (error) {
          client.end(`${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`);
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(socketPath, () => {
        server!.off("error", reject);
        fs.chmodSync(socketPath, 0o600);
        resolve();
      });
    });
  });

  pi.on("session_shutdown", async () => {
    const current = server;
    server = undefined;
    if (!current) return;
    for (const client of clients) client.destroy();
    await new Promise<void>((resolve, reject) => current.close((error) => error ? reject(error) : resolve()));
  });
}
