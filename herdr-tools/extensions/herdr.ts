import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import {
  closePane,
  commandText,
  resolveCwd,
  runHerdr,
  runHerdrJson,
  runInPane,
  sendTextToPane,
  shellQuote,
  type HerdrPaneInfo,
} from "./herdr-helpers.ts";

const STATE_DIR = path.join(os.tmpdir(), "pi-herdr-panels");
const PANEL_REGISTRY = path.join(STATE_DIR, "panels.json");
const DEFAULT_CAPTURE_LINES = 500;

const captureState = new Map<string, string>();

interface PanelRegistryEntry {
  name: string;
  paneId: string;
  terminalId?: string;
  cwd: string;
  command?: string;
  updatedAt: string;
}

type PanelRegistry = Record<string, PanelRegistryEntry>;

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

async function listPanes(pi: ExtensionAPI, signal?: AbortSignal): Promise<HerdrPaneInfo[]> {
  const response = await runHerdrJson(pi, ["pane", "list"], signal);
  return Array.isArray(response?.result?.panes) ? response.result.panes : [];
}

async function resolvePanelTarget(pi: ExtensionAPI, target: string, signal?: AbortSignal): Promise<{ paneId: string; name?: string; entry?: PanelRegistryEntry }> {
  const safe = sanitizeName(target);
  const registry = readRegistry();
  const entry = registry[safe] ?? registry[target];
  if (!entry) return { paneId: target };

  const panes = await listPanes(pi, signal).catch(() => []);
  const byTerminal = entry.terminalId ? panes.find((pane) => pane.terminal_id === entry.terminalId) : undefined;
  if (byTerminal?.pane_id) {
    if (byTerminal.pane_id !== entry.paneId) {
      rememberPanel({ ...entry, paneId: byTerminal.pane_id });
      return { paneId: byTerminal.pane_id, name: entry.name, entry: { ...entry, paneId: byTerminal.pane_id } };
    }
    return { paneId: byTerminal.pane_id, name: entry.name, entry };
  }
  if (panes.some((pane) => pane.pane_id === entry.paneId)) return { paneId: entry.paneId, name: entry.name, entry };
  return { paneId: entry.paneId, name: entry.name, entry };
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

function diffSinceLast(key: string, current: string): string {
  const previous = captureState.get(key);
  captureState.set(key, current);
  if (!previous) return current || "(no output)";
  if (current === previous) return "(no new output)";
  if (current.startsWith(previous)) return current.slice(previous.length).trimStart() || "(no new output)";
  const index = current.indexOf(previous);
  if (index >= 0) return current.slice(index + previous.length).trimStart() || "(no new output)";
  return current || "(no output; previous capture scrolled out of retained recent output)";
}

const herdrBashParams = Type.Object({
  name: Type.String({ description: "Name for the Herdr panel. Reuse this name with herdr-capture, herdr-send, and herdr-close." }),
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
  lines: Type.Optional(Type.Number({ description: `Number of recent lines to read. Defaults to ${DEFAULT_CAPTURE_LINES}. Passing lines returns the whole requested window and updates the new-output cursor.` })),
  source: Type.Optional(Type.Union([Type.Literal("visible"), Type.Literal("recent"), Type.Literal("recent-unwrapped")], { description: "Read source. Defaults to recent." })),
});
type HerdrCaptureParams = Static<typeof herdrCaptureParams>;

const herdrSendParams = Type.Object({
  target: Type.String({ description: "Panel name or Herdr pane id." }),
  text: Type.String({ description: "Text or command to send." }),
  enter: Type.Optional(Type.Boolean({ description: "Whether to press Enter after sending text. Defaults to true." })),
});
type HerdrSendParams = Static<typeof herdrSendParams>;

const herdrCloseParams = Type.Object({
  target: Type.String({ description: "Panel name or Herdr pane id." }),
});
type HerdrCloseParams = Static<typeof herdrCloseParams>;

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
      const pane = tabResponse?.result?.root_pane;
      const tab = tabResponse?.result?.tab;
      if (!pane?.pane_id) {
        throw new Error(`Could not find root pane in Herdr tab response: ${JSON.stringify(tabResponse)}`);
      }
      const command = buildBashPanelCommand(name, params.command);
      await runInPane(pi, pane.pane_id, command, signal);
      rememberPanel({ name, paneId: pane.pane_id, terminalId: pane.terminal_id, cwd, command: params.command });

      let waitText: string | undefined;
      if (params.waitFor?.match) {
        const args = ["wait", "output", pane.pane_id, "--match", params.waitFor.match, "--source", "recent"];
        if (params.waitFor.regex === true) args.push("--regex");
        if (params.waitFor.timeoutMs !== undefined) args.push("--timeout", String(Math.max(0, Math.ceil(params.waitFor.timeoutMs))));
        const waitResult = await runHerdr(pi, args, signal);
        waitText = commandText(waitResult);
        if (waitResult.code !== 0) {
          const recent = await readPanelOutput(pi, pane.pane_id, 80, "recent", signal).catch((error) => String(error));
          throw new Error([`Started panel '${name}' at ${pane.pane_id}, but readiness wait failed.`, waitText, "", "Recent output:", recent].join("\n"));
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
    description: "Read a named Herdr panel or pane. Without lines, returns output since the previous capture when possible; with lines, returns that complete window. Resolution and read failures throw.",
    parameters: herdrCaptureParams,
    async execute(_toolCallId, params: HerdrCaptureParams, signal) {
      const resolved = await resolvePanelTarget(pi, params.target, signal);
      const source = params.source ?? "recent";
      const lines = params.lines ?? DEFAULT_CAPTURE_LINES;
      const current = await readPanelOutput(pi, resolved.paneId, lines, source, signal);
      const key = `${resolved.name ?? params.target}:${resolved.paneId}:${source}`;
      const text = params.lines === undefined ? diffSinceLast(key, current) : current;
      if (params.lines !== undefined) captureState.set(key, current);
      return { content: [{ type: "text", text }], details: { paneId: resolved.paneId, name: resolved.name, lines, source } };
    },
  });

  pi.registerTool({
    name: "herdr-send",
    label: "Herdr Send",
    description: "Send text to a named Herdr panel or pane, pressing Enter unless disabled. Returns the resolved target acknowledgement; resolution or send failures throw.",
    parameters: herdrSendParams,
    async execute(_toolCallId, params: HerdrSendParams, signal) {
      const resolved = await resolvePanelTarget(pi, params.target, signal);
      await sendTextToPane(pi, resolved.paneId, params.text, params.enter !== false, signal);
      return { content: [{ type: "text", text: `Sent to ${resolved.name ?? resolved.paneId}.` }], details: { paneId: resolved.paneId, name: resolved.name, enter: params.enter !== false } };
    },
  });

  pi.registerTool({
    name: "herdr-close",
    label: "Herdr Close",
    description: "Close a named Herdr panel or pane and remove its registry/capture state. Returns the closed target acknowledgement; resolution or close failures throw.",
    parameters: herdrCloseParams,
    async execute(_toolCallId, params: HerdrCloseParams, signal) {
      const resolved = await resolvePanelTarget(pi, params.target, signal);
      await closePane(pi, resolved.paneId, signal);
      forgetPanel(params.target);
      forgetPanel(resolved.paneId);
      for (const key of [...captureState.keys()]) {
        if (key.startsWith(`${params.target}:`) || key.includes(`:${resolved.paneId}:`)) captureState.delete(key);
      }
      return { content: [{ type: "text", text: `Closed ${resolved.name ?? resolved.paneId}.` }], details: { paneId: resolved.paneId, name: resolved.name } };
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
