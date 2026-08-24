import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import {
  closePane,
  commandText,
  getPane,
  paneWaitOutputArgs,
  resolveCwd,
  runHerdr,
  runHerdrJson,
  runInPane,
  sendKeysToPane,
  sendTextToPane,
  shellQuote,
  type HerdrPaneInfo,
} from "./herdr-helpers.ts";

const STATE_DIR = path.join(os.tmpdir(), "pi-herdr-panels");
const PANEL_REGISTRY = path.join(STATE_DIR, "panels.json");
const DEFAULT_CAPTURE_LINES = 500;

interface CaptureCursor {
  text: string;
  totalRows?: number;
}

const captureState = new Map<string, CaptureCursor>();

interface PanelRegistryEntry {
  name: string;
  paneId: string;
  terminalId?: string;
  cwd: string;
  command?: string;
  updatedAt: string;
}

type PanelRegistry = Record<string, PanelRegistryEntry>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function ensureStateDir(): void {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
}

function sanitizeName(name: string): string {
  return name.replace(/[^A-Za-z0-9._:-]/g, "");
}

function validatePanelName(name: string): string {
  const safe = sanitizeName(name.trim());
  if (!safe || safe !== name.trim() || safe === "." || safe === ".." || safe.includes("..")) {
    throw new Error("panel name must contain only letters, numbers, '.', '_', ':', or '-' and must not contain '..'.");
  }
  return safe;
}

function readRegistry(): PanelRegistry {
  try {
    return JSON.parse(fs.readFileSync(PANEL_REGISTRY, "utf8"));
  } catch {
    return {};
  }
}

function writeRegistry(registry: PanelRegistry): void {
  ensureStateDir();
  const tmp = `${PANEL_REGISTRY}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(registry, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, PANEL_REGISTRY);
}

function rememberPanel(entry: Omit<PanelRegistryEntry, "updatedAt">): void {
  const registry = readRegistry();
  registry[entry.name] = { ...entry, updatedAt: new Date().toISOString() };
  writeRegistry(registry);
}

function forgetPanel(target: string): void {
  const safe = sanitizeName(target);
  const registry = readRegistry();
  delete registry[safe];
  for (const [name, entry] of Object.entries(registry)) {
    if (entry.paneId === target || entry.terminalId === target) delete registry[name];
  }
  writeRegistry(registry);
}

function clearCaptureState(...targets: string[]): void {
  for (const key of [...captureState.keys()]) {
    if (targets.some((target) => target !== "" && (key.startsWith(`${target}:`) || key.includes(`:${target}:`)))) {
      captureState.delete(key);
    }
  }
}

function responseResult(response: unknown): Record<string, unknown> | undefined {
  return isRecord(response) && isRecord(response.result) ? response.result : undefined;
}

async function listPanes(pi: ExtensionAPI, signal?: AbortSignal): Promise<HerdrPaneInfo[]> {
  const panes = responseResult(await runHerdrJson(pi, ["pane", "list"], signal))?.panes;
  if (!Array.isArray(panes)) return [];
  return panes.filter((pane): pane is HerdrPaneInfo => isRecord(pane) && typeof pane.pane_id === "string");
}

async function resolvePanelTarget(pi: ExtensionAPI, target: string, signal?: AbortSignal): Promise<{ pane: HerdrPaneInfo; name?: string }> {
  const safe = sanitizeName(target);
  const registry = readRegistry();
  const entry = registry[safe] ?? registry[target];
  const panes = await listPanes(pi, signal);
  if (!entry) {
    const pane = panes.find((candidate) => candidate.pane_id === target || candidate.terminal_id === target);
    if (!pane) throw new Error(`Herdr pane '${target}' is not running.`);
    return { pane };
  }

  const pane = entry.terminalId
    ? panes.find((candidate) => candidate.terminal_id === entry.terminalId)
    : panes.find((candidate) => candidate.pane_id === entry.paneId);
  if (!pane?.pane_id) {
    forgetPanel(entry.name);
    clearCaptureState(entry.name, entry.paneId, entry.terminalId ?? "");
    throw new Error(`Herdr panel '${entry.name}' is no longer running.`);
  }
  if (pane.pane_id !== entry.paneId) {
    rememberPanel({ ...entry, paneId: pane.pane_id });
  }
  return { pane, name: entry.name };
}

function buildBashPanelCommand(name: string, userCommand: string): string {
  ensureStateDir();
  const scriptPath = path.join(STATE_DIR, `${name}-${process.pid}-${Date.now()}.sh`);
  const script = [
    "#!/usr/bin/env bash",
    `printf '\\n[herdr-bash:${name} starting]\\n'`,
    userCommand,
    "status=$?",
    `printf '\\n[herdr-bash:${name} exited with status %s]\\n' "$status"`,
    "rm -f -- \"$0\"",
    "",
  ].join("\n");
  fs.writeFileSync(scriptPath, script, { encoding: "utf8", mode: 0o700 });
  return `bash ${shellQuote(scriptPath)}`;
}

async function readPanelOutput(pi: ExtensionAPI, paneId: string, lines: number, source: "visible" | "recent" | "recent-unwrapped", signal?: AbortSignal): Promise<string> {
  const result = await runHerdr(pi, ["pane", "read", paneId, "--source", source, "--lines", String(lines)], signal);
  const text = commandText(result);
  if (result.code !== 0) throw new Error(text);
  return text;
}

function paneTotalRows(pane: HerdrPaneInfo): number | undefined {
  const maxOffset = pane.scroll?.max_offset_from_bottom;
  const viewportRows = pane.scroll?.viewport_rows;
  return typeof maxOffset === "number" && typeof viewportRows === "number" ? maxOffset + viewportRows : undefined;
}

function trailingLines(text: string, count: number): string {
  if (count <= 0) return "";
  return text.split("\n").slice(-count).join("\n");
}

function outputAfterOverlap(previous: string, current: string): string | undefined {
  const previousLines = previous.split("\n");
  const currentLines = current.split("\n");
  const maxOverlap = Math.min(previousLines.length, currentLines.length);
  for (let overlap = maxOverlap; overlap > 0; overlap--) {
    const previousStart = previousLines.length - overlap;
    let matches = true;
    for (let index = 0; index < overlap; index++) {
      if (previousLines[previousStart + index] !== currentLines[index]) {
        matches = false;
        break;
      }
    }
    if (matches) return currentLines.slice(overlap).join("\n");
  }
  return undefined;
}

function diffSinceLast(previous: CaptureCursor | undefined, current: string, totalRows: number | undefined): string {
  if (!previous) return current || "(no output)";
  const rowDelta = totalRows !== undefined && previous.totalRows !== undefined
    ? totalRows - previous.totalRows
    : undefined;
  let output: string;
  if (current === previous.text) {
    output = rowDelta !== undefined && rowDelta > 0
      ? trailingLines(current, Math.min(rowDelta, DEFAULT_CAPTURE_LINES))
      : "(no new output)";
  } else if (current.startsWith(previous.text)) {
    output = current.slice(previous.text.length).trimStart() || "(no new output)";
  } else {
    const previousIndex = current.indexOf(previous.text);
    const overlap = previousIndex < 0 ? outputAfterOverlap(previous.text, current) : undefined;
    if (previousIndex >= 0) output = current.slice(previousIndex + previous.text.length).trimStart() || "(no new output)";
    else if (overlap !== undefined) output = overlap || "(no new output)";
    else if (rowDelta !== undefined && rowDelta > 0) output = trailingLines(current, Math.min(rowDelta, DEFAULT_CAPTURE_LINES));
    else output = current || "(no output; previous capture scrolled out of retained recent output)";
  }
  return rowDelta !== undefined && rowDelta > DEFAULT_CAPTURE_LINES
    ? `[${rowDelta} new terminal rows; showing the last ${DEFAULT_CAPTURE_LINES}.]\n\n${output}`
    : output;
}

const herdrBashParams = Type.Object({
  name: Type.String({ description: "Name for the Herdr panel. Reuse this name with herdr-capture and herdr-send." }),
  command: Type.String({ description: "Command to run in the panel. Intended for long-running processes such as servers, watchers, and builds." }),
  folder: Type.Optional(Type.String({ description: "Working directory. Defaults to the current working directory." })),
  waitFor: Type.Optional(Type.Object({
    match: Type.String({ description: "Optional readiness text or regex to wait for after starting the command." }),
    regex: Type.Optional(Type.Boolean({ description: "Treat waitFor.match as a regex. Defaults to false." })),
    timeoutMs: Type.Optional(Type.Number({ description: "Readiness wait timeout in milliseconds. Defaults to Herdr's wait default." })),
  })),
});
type HerdrBashParams = Static<typeof herdrBashParams>;

const herdrCaptureParams = Type.Object({
  target: Type.String({ description: "Panel name or Herdr pane id." }),
  lines: Type.Optional(Type.Integer({ minimum: 1, description: `Number of recent lines to read. Defaults to ${DEFAULT_CAPTURE_LINES}. Passing lines returns the whole requested window and updates the new-output cursor.` })),
  source: Type.Optional(Type.Union([Type.Literal("visible"), Type.Literal("recent"), Type.Literal("recent-unwrapped")], { description: "Read source. Defaults to recent." })),
  close: Type.Optional(Type.Boolean({ description: "Close the panel after capturing its final output. Defaults to false." })),
});
type HerdrCaptureParams = Static<typeof herdrCaptureParams>;

const herdrSendParams = Type.Object({
  target: Type.String({ description: "Panel name, Herdr pane id, or stable terminal id." }),
  text: Type.Optional(Type.String({ description: "Literal text or a command to send." })),
  keys: Type.Optional(Type.Array(Type.String(), { minItems: 1, description: "Key presses to send instead of text, such as ['ctrl+c'] or ['Escape']." })),
  enter: Type.Optional(Type.Boolean({ description: "Whether to press Enter after sending text. Defaults to true. Not valid with keys." })),
});
type HerdrSendParams = Static<typeof herdrSendParams>;

export default function herdrPanelToolsExtension(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    if (process.env.HERDR_ENV !== "1") {
      ctx.ui.notify("herdr panel tools: not running inside Herdr; tools require HERDR_ENV=1.", "warning");
    }
  });

  pi.registerTool({
    name: "herdr-bash",
    label: "Herdr Bash",
    description: "Start a named Herdr panel for a long-running command; waitFor can block on readiness. Returns tab, pane, cwd, command, and readiness text. Creation failures throw; readiness failures throw with recent output.",
    parameters: herdrBashParams,
    async execute(_toolCallId, params: HerdrBashParams, signal, _onUpdate, ctx) {
      const name = validatePanelName(params.name);
      const cwd = resolveCwd(ctx.cwd, params.folder);
      const existing = readRegistry()[name];
      if (existing) {
        const panes = await listPanes(pi, signal);
        const livePane = existing.terminalId
          ? panes.find((pane) => pane.terminal_id === existing.terminalId)
          : panes.find((pane) => pane.pane_id === existing.paneId);
        if (livePane) {
          throw new Error(`Herdr panel '${name}' is already running at ${livePane.pane_id}. Close it before reusing the name.`);
        }
        forgetPanel(name);
        clearCaptureState(name, existing.paneId, existing.terminalId ?? "");
      }
      const tabResponse = await runHerdrJson(pi, [
        "tab",
        "create",
        "--cwd",
        cwd,
        "--label",
        name,
        "--env",
        `HERDR_PANEL_NAME=${name}`,
        "--no-focus",
      ], signal);
      const result = responseResult(tabResponse);
      const paneValue = result?.root_pane;
      const tabValue = result?.tab;
      if (!isRecord(paneValue) || typeof paneValue.pane_id !== "string") {
        throw new Error(`Could not find root pane in Herdr tab response: ${JSON.stringify(tabResponse)}`);
      }
      const pane = paneValue as unknown as HerdrPaneInfo;
      const tab = isRecord(tabValue) && typeof tabValue.tab_id === "string"
        ? { tab_id: tabValue.tab_id }
        : undefined;
      const command = buildBashPanelCommand(name, params.command);
      await runInPane(pi, pane.pane_id, command, signal);
      rememberPanel({ name, paneId: pane.pane_id, terminalId: pane.terminal_id, cwd, command: params.command });

      let waitText: string | undefined;
      if (params.waitFor?.match) {
        const waitResult = await runHerdr(pi, paneWaitOutputArgs(pane.pane_id, params.waitFor), signal);
        if (waitResult.code !== 0) {
          const failure = commandText(waitResult);
          const recent = await readPanelOutput(pi, pane.pane_id, 80, "recent", signal).catch((error) => String(error));
          throw new Error([`Started panel '${name}' at ${pane.pane_id}, but readiness wait failed.`, failure, "", "Recent output:", recent].join("\n"));
        }
        try {
          const response = JSON.parse(waitResult.stdout) as { result?: { matched_line?: unknown } };
          waitText = typeof response.result?.matched_line === "string" ? response.result.matched_line : commandText(waitResult);
        } catch {
          waitText = commandText(waitResult);
        }
      }

      const text = [
        `Started Herdr panel '${name}'.`,
        `Tab: ${tab?.tab_id ?? "unknown"}`,
        `Pane: ${pane.pane_id}`,
        `Cwd: ${cwd}`,
        `Command: ${params.command}`,
        waitText ? `Readiness: ${waitText}` : undefined,
      ].filter(Boolean).join("\n");
      return { content: [{ type: "text", text }], details: { name, tab, pane, cwd, command: params.command, readiness: waitText } };
    },
  });

  pi.registerTool({
    name: "herdr-capture",
    label: "Herdr Capture",
    description: "Read a named Herdr panel or pane. Without lines, returns output since the previous capture when possible; with lines, returns that complete window. Set close to capture final output and close the panel. Resolution, read, and close failures throw.",
    parameters: herdrCaptureParams,
    async execute(_toolCallId, params: HerdrCaptureParams, signal) {
      const resolved = await resolvePanelTarget(pi, params.target, signal);
      const source = params.source ?? "recent";
      const lines = params.lines ?? DEFAULT_CAPTURE_LINES;
      const current = await readPanelOutput(pi, resolved.pane.pane_id, lines, source, signal);
      const latestPane = await getPane(pi, resolved.pane.pane_id, signal) ?? resolved.pane;
      const stablePaneId = latestPane.terminal_id ?? resolved.pane.terminal_id ?? resolved.pane.pane_id;
      const key = `${stablePaneId}:${source}`;
      const totalRows = paneTotalRows(latestPane);
      const previous = captureState.get(key);
      const text = params.lines === undefined ? diffSinceLast(previous, current, totalRows) : current;

      if (params.close === true) {
        await closePane(pi, resolved.pane.pane_id, signal);
        forgetPanel(params.target);
        forgetPanel(resolved.pane.pane_id);
        clearCaptureState(params.target, resolved.name ?? "", resolved.pane.pane_id, stablePaneId);
      } else {
        captureState.set(key, { text: current, totalRows });
      }

      return {
        content: [{ type: "text", text }],
        details: { paneId: resolved.pane.pane_id, name: resolved.name, lines, source, closed: params.close === true },
      };
    },
  });

  pi.registerTool({
    name: "herdr-send",
    label: "Herdr Send",
    description: "Send either text or key presses to a named Herdr panel or pane. Text presses Enter unless disabled; keys supports values such as ctrl+c and Escape. Exactly one of text or keys is required.",
    parameters: herdrSendParams,
    async execute(_toolCallId, params: HerdrSendParams, signal) {
      if ((params.text === undefined) === (params.keys === undefined)) {
        throw new Error("Exactly one of text or keys is required.");
      }
      if (params.keys !== undefined && params.enter !== undefined) {
        throw new Error("enter is only valid when sending text.");
      }

      const resolved = await resolvePanelTarget(pi, params.target, signal);
      if (params.keys !== undefined) {
        await sendKeysToPane(pi, resolved.pane.pane_id, params.keys, signal);
      } else {
        await sendTextToPane(pi, resolved.pane.pane_id, params.text ?? "", params.enter !== false, signal);
      }
      const target = resolved.name ?? resolved.pane.pane_id;
      return {
        content: [{ type: "text", text: params.keys ? `Sent keys to ${target}.` : `Sent text to ${target}.` }],
        details: { paneId: resolved.pane.pane_id, name: resolved.name, keys: params.keys, enter: params.keys ? undefined : params.enter !== false },
      };
    },
  });

  pi.registerCommand("herdr-panels", {
    description: "List Herdr panel registry entries. Usage: /herdr-panels",
    handler: async (_args, ctx) => {
      const registry = readRegistry();
      const text = Object.keys(registry).length ? JSON.stringify(registry, null, 2) : "No registered Herdr panels.";
      ctx.ui.notify(text, "info");
    },
  });
}
