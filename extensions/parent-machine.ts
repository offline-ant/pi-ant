import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// connect-pi-attach (nuc-controls/connect-pi) writes STATE_DIR/<port>/session
// while the operator's machine is shared, and removes it when that session ends.
const STATE_DIR = join(homedir(), ".local/state/connect-pi");
const SECTION = "parent_machine";
const OS_LABELS: Record<string, string> = {
  macos: "macOS",
  linux: "Linux",
  windows: "Windows; commands run in Git Bash, which can call cmd and powershell",
};

interface SharedMachine {
  label: string;
  host: string;
  mtime: number;
}

function sharedMachine(file: string): SharedMachine | undefined {
  let text: string;
  let mtime: number;
  try {
    text = readFileSync(file, "utf8");
    mtime = statSync(file).mtimeMs;
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
  const host = fields.get("HOST_NAME") ?? "";
  const os = fields.get("OS") ?? "";
  const user = (fields.get("USER_NAME") ?? "").replaceAll("+", " "); // connect-pi encodes spaces
  return { label: `${user}@${host} (${OS_LABELS[os] ?? os})`, host, mtime };
}

function sharedMachines(): SharedMachine[] {
  let names: string[];
  try {
    names = readdirSync(STATE_DIR);
  } catch {
    return [];
  }
  return names
    .map((name) => sharedMachine(join(STATE_DIR, name, "session")))
    .filter((machine) => machine !== undefined)
    .sort((a, b) => b.mtime - a.mtime);
}

export default function parentMachine(pi: ExtensionAPI): void {
  pi.on("before_agent_start", (event) => {
    const machines = sharedMachines();
    if (machines.length === 0) return;
    const lines =
      machines.length === 1
        ? [`The operator is connected through connect-pi from ${machines[0].label} and shares that machine for this session.`]
        : [
            `The operator shares these machines through connect-pi, most recent first: ${machines.map((m) => m.label).join("; ")}.`,
            `\`parent\` uses the most recent; select another by host name, e.g. \`PARENT=${machines[1].host} parent '<command>'\`.`,
          ];
    lines.push(
      "Run commands there with `parent '<command>'` through bash; for an interactive terminal start a panel whose command is `parent`.",
      "It is a borrowed, trusted machine: change only what the operator asked for and ask before touching system settings.",
    );
    event.systemPromptOptions.sections[SECTION] = lines.join("\n");
  });
}
