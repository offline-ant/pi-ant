import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, SessionEntry, SessionHeader, SessionManager } from "@earendil-works/pi-coding-agent";

export const HERDR_COMMAND_TIMEOUT_MS = 120_000;
const HERDR_SHELL_READY_TIMEOUT_MS = 5_000;
const HERDR_SHELL_RETRY_INTERVAL_MS = 100;

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
  scroll?: {
    max_offset_from_bottom?: number;
    viewport_rows?: number;
  };
}

export interface StartedHerdrAgent {
  agentName: string;
  paneId: string;
  terminalId?: string;
  tabId?: string;
}

interface HerdrRect {
  height: number;
  width: number;
}

interface HerdrLayout {
  area?: HerdrRect;
  focused_pane_id?: string;
  panes?: Array<{
    focused?: boolean;
    pane_id?: string;
    rect?: HerdrRect;
  }>;
}

interface HerdrAgentStartupState {
  tail: Promise<void>;
}

type HerdrAgentPlacement = "new-tab" | "sibling-pane";

const HERDR_AGENT_STARTUP_STATE = Symbol.for("pi-ant.herdr-agent-startup-state");

const HERDR_AGENT_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

export function herdrBin(): string {
  return process.env.HERDR_BIN_PATH || "herdr";
}

export function modelCliArgs(model: { provider: string; id: string } | undefined, thinkingLevel: string): string[] {
  if (!model) throw new Error("Current session has no selected model; cannot start a child Pi process.");
  return ["--provider", model.provider, "--model", model.id, "--thinking", thinkingLevel];
}

export function hasHerdrEnvironment(): boolean {
  return process.env.HERDR_ENV === "1" && Boolean(process.env.HERDR_SOCKET_PATH);
}

export function validateHerdrAgentName(name: string): string {
  if (!HERDR_AGENT_NAME_PATTERN.test(name)) {
    throw new Error("Herdr agent name must start with a lowercase letter, contain only lowercase letters, numbers, '_' or '-', and be at most 32 characters.");
  }
  return name;
}

export function workerAgentName(prefix: "coding" | "delegate" | "history", id: string): string {
  return validateHerdrAgentName(`${prefix}-${id}`);
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

export function requireHerdrEnv(): void {
  if (!hasHerdrEnvironment()) {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function getPreToolCallLeafId(
  sessionManager: Pick<SessionManager, "getBranch">,
  toolName: string,
  toolCallId: string,
): string | null {
  const branch = sessionManager.getBranch();
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    const hasToolCall = entry.message.content.some(
      (item) => isRecord(item)
        && item.type === "toolCall"
        && item.id === toolCallId
        && item.name === toolName,
    );
    if (hasToolCall) return entry.parentId ?? null;
  }

  throw new Error(
    `Could not identify ${toolName} tool call ${toolCallId} in the current session branch; refusing to fork an unmatched transcript.`,
  );
}

function parseJsonResponse(raw: string, command: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`Invalid JSON from ${command}: ${error instanceof Error ? error.message : String(error)}\n${raw}`);
  }
}

export async function runHerdrJson(pi: ExtensionAPI, args: string[], signal?: AbortSignal): Promise<unknown> {
  const result = await runHerdr(pi, args, signal);
  if (result.code !== 0) {
    throw new Error(commandText(result));
  }
  return parseJsonResponse(result.stdout, `herdr ${args.join(" ")}`);
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function responseResult(response: unknown): Record<string, unknown> | undefined {
  if (!isRecord(response) || !isRecord(response.result)) return undefined;
  return response.result;
}

function responsePane(response: unknown): HerdrPaneInfo | undefined {
  const result = responseResult(response);
  const pane = result?.pane ?? result?.agent;
  return isRecord(pane) && typeof pane.pane_id === "string" ? pane as unknown as HerdrPaneInfo : undefined;
}

function responseTab(response: unknown): { tab_id?: string } | undefined {
  const tab = responseResult(response)?.tab;
  return isRecord(tab) ? tab : undefined;
}

function responseRootPane(response: unknown): HerdrPaneInfo | undefined {
  const pane = responseResult(response)?.root_pane;
  return isRecord(pane) && typeof pane.pane_id === "string" ? pane as unknown as HerdrPaneInfo : undefined;
}

function responseLayout(response: unknown): HerdrLayout | undefined {
  const layout = responseResult(response)?.layout;
  return isRecord(layout) ? layout as HerdrLayout : undefined;
}

function parseHerdrErrorCode(raw: string): string | undefined {
  try {
    const response = JSON.parse(raw) as unknown;
    if (!isRecord(response) || !isRecord(response.error)) return undefined;
    return typeof response.error.code === "string" ? response.error.code : undefined;
  } catch {
    return undefined;
  }
}

function herdrErrorCode(result: HerdrCommandResult): string | undefined {
  return parseHerdrErrorCode(result.stdout) ?? parseHerdrErrorCode(result.stderr);
}

async function startAgentWhenShellReady(pi: ExtensionAPI, args: string[], signal?: AbortSignal): Promise<unknown> {
  const startedAt = Date.now();
  while (true) {
    const result = await runHerdr(pi, args, signal);
    if (result.code === 0) return parseJsonResponse(result.stdout, `herdr ${args.join(" ")}`);
    if (herdrErrorCode(result) !== "agent_pane_busy" || Date.now() - startedAt >= HERDR_SHELL_READY_TIMEOUT_MS) {
      throw new Error(commandText(result));
    }
    await new Promise((resolve) => setTimeout(resolve, HERDR_SHELL_RETRY_INTERVAL_MS));
  }
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

export async function getAgent(pi: ExtensionAPI, agentName: string, signal?: AbortSignal): Promise<HerdrPaneInfo | undefined> {
  const result = await runHerdr(pi, ["agent", "get", agentName], signal);
  if (result.code !== 0) {
    if (herdrErrorCode(result) === "agent_not_found") return undefined;
    throw new Error(commandText(result));
  }
  return responsePane(parseJsonResponse(result.stdout, `herdr agent get ${agentName}`));
}

export async function agentExists(pi: ExtensionAPI, agentName: string, signal?: AbortSignal): Promise<boolean> {
  return (await getAgent(pi, agentName, signal)) !== undefined;
}

export async function promptHerdrAgent(pi: ExtensionAPI, agentName: string, prompt: string, signal?: AbortSignal): Promise<void> {
  const result = await runHerdr(pi, ["agent", "prompt", agentName, prompt], signal);
  if (result.code !== 0) throw new Error(commandText(result));
}

export function paneWaitOutputArgs(
  paneId: string,
  waitFor: { match: string; regex?: boolean; timeoutMs?: number },
): string[] {
  const args = waitFor.regex === true
    ? ["pane", "wait-output", paneId, "--regex", waitFor.match]
    : ["pane", "wait-output", paneId, "--match", waitFor.match];
  args.push("--source", "recent");
  if (waitFor.timeoutMs !== undefined) args.push("--timeout", String(Math.max(0, Math.ceil(waitFor.timeoutMs))));
  return args;
}

export async function readPane(pi: ExtensionAPI, paneId: string, lines = 80, signal?: AbortSignal): Promise<string> {
  const result = await runHerdr(pi, ["pane", "read", paneId, "--source", "recent", "--lines", String(lines)], signal);
  const text = commandText(result);
  return result.code === 0 ? text : `Could not read Herdr pane ${paneId}: ${text}`;
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

export async function sendKeysToPane(pi: ExtensionAPI, paneId: string, keys: string[], signal?: AbortSignal): Promise<void> {
  const result = await runHerdr(pi, ["pane", "send-keys", paneId, ...keys], signal);
  if (result.code !== 0) throw new Error(commandText(result));
}

export async function closePane(pi: ExtensionAPI, paneId: string, signal?: AbortSignal): Promise<void> {
  const result = await runHerdr(pi, ["pane", "close", paneId], signal);
  if (result.code !== 0) throw new Error(commandText(result));
}

export async function closeHerdrAgent(
  pi: ExtensionAPI,
  agentName: string,
  fallbackPaneId: string,
  signal?: AbortSignal,
): Promise<void> {
  const agent = await getAgent(pi, agentName, signal).catch(() => undefined);
  await closePane(pi, agent?.pane_id ?? fallbackPaneId, signal);
}

export interface StartHerdrPiAgentOptions {
  name: string;
  cwd: string;
  sessionFile: string;
  piArgs?: string[];
  env?: Record<string, string>;
}

function herdrAgentStartupState(): HerdrAgentStartupState {
  const globals = globalThis as typeof globalThis & Record<symbol, HerdrAgentStartupState | undefined>;
  const current = globals[HERDR_AGENT_STARTUP_STATE];
  if (current) return current;
  const created = { tail: Promise.resolve() };
  globals[HERDR_AGENT_STARTUP_STATE] = created;
  return created;
}

async function createHerdrAgentPane(
  pi: ExtensionAPI,
  options: StartHerdrPiAgentOptions,
  placement: HerdrAgentPlacement,
  signal?: AbortSignal,
): Promise<{ pane: HerdrPaneInfo; tabId?: string }> {
  const env = { ...(options.env ?? {}) };
  if (process.env.PI_NESTED) env.PI_NESTED = process.env.PI_NESTED;

  if (placement === "new-tab") {
    const args = ["tab", "create", "--cwd", options.cwd, "--label", options.name, "--no-focus"];
    for (const [key, value] of Object.entries(env)) args.push("--env", `${key}=${value}`);

    const response = await runHerdrJson(pi, args, signal);
    const pane = responseRootPane(response);
    if (!pane) {
      throw new Error(`Could not find root pane in Herdr tab response: ${JSON.stringify(response)}`);
    }
    return { pane, tabId: responseTab(response)?.tab_id };
  }

  const layoutResponse = await runHerdrJson(pi, ["pane", "layout", "--current"], signal);
  const layout = responseLayout(layoutResponse);
  const currentPane = layout?.panes?.find(
    (pane) => pane.pane_id === layout.focused_pane_id || pane.focused === true,
  );
  const area = currentPane?.rect ?? layout?.area;
  if (!area) {
    throw new Error(`Could not find current pane area in Herdr layout response: ${JSON.stringify(layoutResponse)}`);
  }

  const direction = area.width >= area.height * 2 ? "right" : "down";
  const args = [
    "pane", "split", "--current", "--direction", direction,
    "--cwd", options.cwd, "--no-focus",
  ];
  for (const [key, value] of Object.entries(env)) args.push("--env", `${key}=${value}`);

  const response = await runHerdrJson(pi, args, signal);
  const pane = responsePane(response);
  if (!pane) {
    throw new Error(`Could not find pane in Herdr split response: ${JSON.stringify(response)}`);
  }
  return { pane, tabId: pane.tab_id ?? process.env.HERDR_TAB_ID };
}

async function startHerdrPiAgentUnlocked(
  pi: ExtensionAPI,
  options: StartHerdrPiAgentOptions,
  placement: HerdrAgentPlacement,
  signal?: AbortSignal,
): Promise<StartedHerdrAgent> {
  const agentName = validateHerdrAgentName(options.name);
  if (!fs.existsSync(options.sessionFile)) {
    throw new Error(`session file does not exist: ${options.sessionFile}`);
  }

  const { pane, tabId } = await createHerdrAgentPane(pi, options, placement, signal);
  const startArgs = [
    "agent",
    "start",
    agentName,
    "--kind",
    "pi",
    "--pane",
    pane.pane_id,
    "--",
    "--session",
    options.sessionFile,
    ...(options.piArgs ?? []),
  ];
  try {
    const agentResponse = await startAgentWhenShellReady(pi, startArgs, signal);
    const agent = responsePane(agentResponse);
    if (!agent) {
      throw new Error(`Could not find agent in Herdr start response: ${JSON.stringify(agentResponse)}`);
    }
    return {
      agentName,
      paneId: agent.pane_id,
      terminalId: agent.terminal_id,
      tabId,
    };
  } catch (error) {
    await closePane(pi, pane.pane_id).catch(() => undefined);
    throw error;
  }
}

async function startHerdrPiAgentWithPlacement(
  pi: ExtensionAPI,
  options: StartHerdrPiAgentOptions,
  placement: HerdrAgentPlacement,
  signal?: AbortSignal,
): Promise<StartedHerdrAgent> {
  const startupState = herdrAgentStartupState();
  const previousStartup = startupState.tail;
  let releaseStartup!: () => void;
  startupState.tail = new Promise<void>((resolve) => {
    releaseStartup = resolve;
  });

  await previousStartup;
  try {
    signal?.throwIfAborted();
    return await startHerdrPiAgentUnlocked(pi, options, placement, signal);
  } finally {
    releaseStartup();
  }
}

export async function startHerdrPiAgent(
  pi: ExtensionAPI,
  options: StartHerdrPiAgentOptions,
  signal?: AbortSignal,
): Promise<StartedHerdrAgent> {
  return startHerdrPiAgentWithPlacement(pi, options, "new-tab", signal);
}

export async function startHerdrPiAgentInSiblingPane(
  pi: ExtensionAPI,
  options: StartHerdrPiAgentOptions,
  signal?: AbortSignal,
): Promise<StartedHerdrAgent> {
  return startHerdrPiAgentWithPlacement(pi, options, "sibling-pane", signal);
}

export function resolveCwd(base: string, folder?: string): string {
  const cwd = path.resolve(base, folder ?? ".");
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    throw new Error(`folder does not exist or is not a directory: ${cwd}`);
  }
  return cwd;
}
