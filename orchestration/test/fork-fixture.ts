import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { flushSessionFile } from "../context.ts";
import { removeTarget } from "../workers.ts";

/** Fake tmux transport with a real local terminal-input acknowledgement endpoint. */
export function forkFixture() {
  process.env.PI_ORCHESTRATION_HOST = "tmux";
  process.env.PI_ORCHESTRATION_ENDPOINT = "/tmp/pi-fork-fake-tmux";
  process.env.TMUX_PANE = "%901";
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fork-test-"));
  let session = SessionManager.create(directory, directory);
  session.appendMessage({ role: "user", content: "Parent context", timestamp: Date.now() });
  const sessionFile = session.getSessionFile()!;
  flushSessionFile(session, sessionFile);
  session = SessionManager.open(sessionFile);
  const commands: string[][] = [];
  const prompts: string[] = [];
  const children: string[] = [];
  const targets: string[] = [];
  const exitedPanes = new Set<string>();
  const servers: net.Server[] = [];
  const controlDirectories: string[] = [];
  let failure: string | undefined;
  const pi = {
    getActiveTools: () => ["read", "ask", "delegate", "unknown-in-child"],
    getThinkingLevel: () => "high",
    exec: async (_command: string, args: string[]) => {
      commands.push(args);
      let stdout = "";
      if (args.includes("split-window") || args.includes("new-window")) {
        const command = args.at(-1)!;
        const child = /--session' '([^']+)'/.exec(command)?.[1];
        if (child) children.push(child);
        if (failure) throw new Error(failure);
        const socketPath = args.find((arg) => arg.startsWith("PI_ORCHESTRATION_CONTROL="))?.split("=")[1];
        if (socketPath) {
          controlDirectories.push(path.dirname(socketPath));
          const server = net.createServer((socket) => {
            let input = "";
            socket.on("data", (data) => {
              input += data.toString();
              if (!input.endsWith("\n")) return;
              const request = JSON.parse(input) as { kind: string; text?: string };
              if (request.kind === "prompt" && request.text) prompts.push(request.text);
              socket.end(JSON.stringify({ dispatched: true }));
            });
          });
          await new Promise<void>((resolve) => server.listen(socketPath, resolve));
          servers.push(server);
        }
        stdout = `%${902 + children.length}\n`;
      } else if (args.includes("display-message")) {
        stdout = exitedPanes.has(args[args.indexOf("-t") + 1]) ? "1\n" : "0\n";
      }
      return { code: 0, stdout, stderr: "", killed: false };
    },
  } as unknown as ExtensionAPI;
  return {
    directory, session, sessionFile, pi, commands, prompts, children, targets, exitedPanes,
    failStart: (message: string) => { failure = message; },
    cleanup: async () => {
      for (const server of servers) await new Promise<void>((resolve) => server.close(() => resolve()));
      for (const target of targets) removeTarget(target);
      for (const child of children) {
        fs.rmSync(child, { force: true });
        try { fs.rmdirSync(path.dirname(child)); } catch { /* A sibling may still own a file here. */ }
      }
      for (const control of controlDirectories) fs.rmSync(control, { recursive: true, force: true });
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}
