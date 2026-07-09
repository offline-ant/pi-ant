import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, SessionEntry, SessionHeader, SessionManager } from "@earendil-works/pi-coding-agent";

export const TMUX_SCRIPT = path.resolve(__dirname, "../bin/pi-tmux");
export const TMUX_COMMAND_TIMEOUT_MS = 120_000;

export function flushSessionFile(sessionManager: SessionManager, sessionFile: string): void {
  const header = sessionManager.getHeader();
  if (!header) {
    throw new Error("New session has no header");
  }

  const entries: Array<SessionHeader | SessionEntry> = [header, ...sessionManager.getEntries()];
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  fs.writeFileSync(sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
}

export function writePromptFile(prompt: string, prefix = "pi-tmux-fork-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const file = path.join(dir, "prompt.md");
  fs.writeFileSync(file, prompt, "utf8");
  return file;
}

export async function runTmux(pi: ExtensionAPI, args: string[], signal?: AbortSignal) {
  return pi.exec("bash", [TMUX_SCRIPT, ...args], { signal, timeout: TMUX_COMMAND_TIMEOUT_MS });
}
