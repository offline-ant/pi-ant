import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Written by connect-pi-attach (nuc-controls/connect-pi) while the
// operator's machine is shared, and removed when that session ends.
const SESSION_FILE = join(homedir(), ".local/state/connect-pi/session");
const SECTION = "parent_machine";

function sharedMachine(): string | undefined {
  let text: string;
  try {
    text = readFileSync(SESSION_FILE, "utf8");
  } catch {
    return undefined;
  }
  const fields = new Map<string, string>();
  for (const line of text.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) fields.set(line.slice(0, eq), line.slice(eq + 1));
  }
  const pid = Number(fields.get("PID"));
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    process.kill(pid, 0); // the attach process ends with the session
  } catch {
    return undefined;
  }
  return `${fields.get("USER_NAME")}@${fields.get("HOST_NAME")}`;
}

export default function parentMachine(pi: ExtensionAPI): void {
  pi.on("before_agent_start", (event) => {
    const machine = sharedMachine();
    if (!machine) return;
    event.systemPromptOptions.sections[SECTION] = [
      `The operator is connected through connect-pi from ${machine} (usually macOS) and shares that machine for this session.`,
      "Run commands there with `parent '<command>'` through bash; for an interactive terminal start a panel whose command is `parent`.",
      "It is a borrowed, trusted machine: change only what the operator asked for and ask before touching system settings.",
    ].join("\n");
  });
}
