import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, SessionEntry, SessionHeader, SessionManager } from "@earendil-works/pi-coding-agent";

export const HERDR_COMMAND_TIMEOUT_MS = 120_000;

export interface HerdrCommandResult {
  code: number;
  stdout: string;
  stderr: string;
  killed: boolean;
}

export interface HerdrPaneInfo {
  pane_id: string;
  terminal_id?: string;
  workspace_id?: string;
  tab_id?: string;
  agent?: string;
  agent_status?: string;
  cwd?: string;
  foreground_cwd?: string;
  focused?: boolean;
}

export interface StartedHerdrPane {
  paneId: string;
  terminalId?: string;
  tabId?: string;
  requestedName: string;
  command: string;
}

export function herdrBin(): string {
  return process.env.HERDR_BIN_PATH || "herdr";
}

export function flushSessionFile(sessionManager: SessionManager, sessionFile: string): void {
  const header = sessionManager.getHeader();
  if (!header) {
    throw new Error("New session has no header");
  }

  const entries: Array<SessionHeader | SessionEntry> = [header, ...sessionManager.getEntries()];
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  fs.writeFileSync(sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
}

export function writePromptFile(prompt: string, prefix = "pi-herdr-fork-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const file = path.join(dir, "prompt.md");
  fs.writeFileSync(file, prompt, "utf8");
  return file;
}

export function requireHerdrEnv(): void {
  if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_SOCKET_PATH) {
    throw new Error("herdr-tools requires pi to run inside a Herdr pane (HERDR_ENV=1 and HERDR_SOCKET_PATH set).");
  }
}

export async function runHerdr(pi: ExtensionAPI, args: string[], signal?: AbortSignal): Promise<HerdrCommandResult> {
  requireHerdrEnv();
  return pi.exec(herdrBin(), args, { signal, timeout: HERDR_COMMAND_TIMEOUT_MS });
}

export function commandText(result: HerdrCommandResult): string {
  const out = result.stdout.trim();
  const err = result.stderr.trim();
  if (out && err) return `${out}\n${err}`;
  return out || err || "(no output)";
}

function parseJsonResponse(raw: string, command: string): any {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON from ${command}: ${error instanceof Error ? error.message : String(error)}\n${raw}`);
  }
}

export async function runHerdrJson(pi: ExtensionAPI, args: string[], signal?: AbortSignal): Promise<any> {
  const result = await runHerdr(pi, args, signal);
  if (result.code !== 0) {
    throw new Error(commandText(result));
  }
  return parseJsonResponse(result.stdout, `herdr ${args.join(" ")}`);
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function shellJoin(args: string[]): string {
  return args.map(shellQuote).join(" ");
}

function envAssignment(key: string, value: string): string {
  return `${key}=${shellQuote(value)}`;
}

function responsePane(response: any): HerdrPaneInfo | undefined {
  return response?.result?.pane ?? response?.result?.agent;
}

export async function getPane(pi: ExtensionAPI, paneId: string, signal?: AbortSignal): Promise<HerdrPaneInfo | undefined> {
  const result = await runHerdr(pi, ["pane", "get", paneId], signal);
  if (result.code !== 0) return undefined;
  try {
    return responsePane(JSON.parse(result.stdout));
  } catch {
    return undefined;
  }
}

export async function paneExists(pi: ExtensionAPI, paneId: string, signal?: AbortSignal): Promise<boolean> {
  return (await getPane(pi, paneId, signal)) !== undefined;
}

export async function readPane(pi: ExtensionAPI, paneId: string, lines = 80, signal?: AbortSignal): Promise<string> {
  const result = await runHerdr(pi, ["pane", "read", paneId, "--source", "recent", "--lines", String(lines)], signal);
  const text = commandText(result);
  return result.code === 0 ? text : `Could not read Herdr pane ${paneId}: ${text}`;
}

export async function splitPane(pi: ExtensionAPI, options: { cwd: string; direction?: "right" | "down"; env?: Record<string, string>; label?: string }, signal?: AbortSignal): Promise<HerdrPaneInfo> {
  const args = [
    "pane",
    "split",
    "--current",
    "--direction",
    options.direction ?? "right",
    "--cwd",
    options.cwd,
    "--no-focus",
  ];
  for (const [key, value] of Object.entries(options.env ?? {})) {
    args.push("--env", `${key}=${value}`);
  }

  const response = await runHerdrJson(pi, args, signal);
  const pane = responsePane(response);
  if (!pane?.pane_id) {
    throw new Error(`Could not find pane in Herdr split response: ${JSON.stringify(response)}`);
  }

  if (options.label) {
    await runHerdr(pi, ["pane", "rename", pane.pane_id, options.label], signal).catch(() => undefined);
  }

  return pane;
}

export async function runInPane(pi: ExtensionAPI, paneId: string, command: string, signal?: AbortSignal): Promise<void> {
  const result = await runHerdr(pi, ["pane", "run", paneId, command], signal);
  if (result.code !== 0) {
    throw new Error(commandText(result));
  }
}

export async function sendTextToPane(pi: ExtensionAPI, paneId: string, text: string, enter = true, signal?: AbortSignal): Promise<void> {
  const args = enter ? ["pane", "run", paneId, text] : ["pane", "send-text", paneId, text];
  const result = await runHerdr(pi, args, signal);
  if (result.code !== 0) throw new Error(commandText(result));
}

export async function closePane(pi: ExtensionAPI, paneId: string, signal?: AbortSignal): Promise<void> {
  const result = await runHerdr(pi, ["pane", "close", paneId], signal);
  if (result.code !== 0) throw new Error(commandText(result));
}

export async function startHerdrPiPane(
  pi: ExtensionAPI,
  options: {
    name: string;
    cwd: string;
    sessionFile: string;
    piArgs?: string[];
    promptFile?: string;
    direction?: "right" | "down";
    placement?: "split" | "tab";
    env?: Record<string, string>;
  },
  signal?: AbortSignal,
): Promise<StartedHerdrPane> {
  if (!fs.existsSync(options.sessionFile)) {
    throw new Error(`session file does not exist: ${options.sessionFile}`);
  }

  const env: Record<string, string> = {
    PI_LOCK_NAME: options.name,
    PI_FORK: "true",
    ...(options.env ?? {}),
  };
  if (process.env.PI_NESTED) env.PI_NESTED = process.env.PI_NESTED;

  const commandArgs = ["pi", "--session", options.sessionFile, ...(options.piArgs ?? [])];
  if (options.promptFile) commandArgs.push(`@${options.promptFile}`);

  if (options.placement === "tab") {
    const args = ["tab", "create", "--cwd", options.cwd, "--label", options.name, "--no-focus"];
    for (const [key, value] of Object.entries(env)) {
      args.push("--env", `${key}=${value}`);
    }
    const response = await runHerdrJson(pi, args, signal);
    const pane = response?.result?.root_pane;
    const tab = response?.result?.tab;
    if (!pane?.pane_id) {
      throw new Error(`Could not find root pane in Herdr tab response: ${JSON.stringify(response)}`);
    }

    const command = [
      "exec env",
      ...Object.entries(env).map(([key, value]) => envAssignment(key, value)),
      shellJoin(commandArgs),
    ].join(" ");
    await runInPane(pi, pane.pane_id, command, signal);
    return {
      paneId: pane.pane_id,
      terminalId: pane.terminal_id,
      tabId: tab?.tab_id,
      requestedName: options.name,
      command,
    };
  }

  const args = [
    "agent",
    "start",
    options.name,
    "--cwd",
    options.cwd,
    "--split",
    options.direction ?? "right",
    "--no-focus",
  ];
  for (const [key, value] of Object.entries(env)) {
    args.push("--env", `${key}=${value}`);
  }
  args.push("--", ...commandArgs);

  const response = await runHerdrJson(pi, args, signal);
  const pane = responsePane(response);
  if (!pane?.pane_id) {
    throw new Error(`Could not find agent pane in Herdr response: ${JSON.stringify(response)}`);
  }

  return {
    paneId: pane.pane_id,
    terminalId: pane.terminal_id,
    requestedName: options.name,
    command: shellJoin(commandArgs),
  };
}

export function resolveCwd(base: string, folder?: string): string {
  const cwd = path.resolve(base, folder ?? ".");
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    throw new Error(`folder does not exist or is not a directory: ${cwd}`);
  }
  return cwd;
}
