import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { getAgentDir, getShellConfig, SettingsManager, truncateTail, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resolveCwd } from "../context.ts";
import { getHost, hostForTarget } from "../host.ts";
import type { Host, HostTarget } from "../host-types.ts";
import { renderToolCall } from "../tool-call.ts";
import { claimName, listTargets, readTarget, removeTarget, saveTarget, validateName } from "../workers.ts";

const MAX_LINES = 2000;
const MAX_BYTES = 50 * 1024;
const DEFAULT_LINES = 500;
/** Terminals answer input asynchronously; settle briefly so the returned snapshot shows the effect. */
const SETTLE_MS = 250;
const nameSchema = Type.String({ description: "Registered panel name, not a native pane or buffer ID." });

function identity(target: HostTarget): string {
  return `${target.name} [${target.host}]`;
}

function snapshot(text: string, lines = MAX_LINES): string {
  const result = truncateTail(text, { maxLines: lines, maxBytes: MAX_BYTES });
  return (result.content || "(no output)") + (result.truncated
    ? "\n[Snapshot truncated to the last requested lines or 50KB; inspect the native panel for earlier output.]"
    : "");
}

/** Run a panel command in the shell Pi's bash tool resolves, as a login shell when that is bash. */
export function panelArgv(command: string, ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted">): string[] {
  const shellPath = SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: ctx.isProjectTrusted() }).getShellPath();
  const config = getShellConfig(shellPath);
  if (config.commandTransport === "stdin") throw new Error(`Panels cannot run commands through ${config.shell}, which reads commands from stdin`);
  return [config.shell, ...(path.basename(config.shell) === "bash" ? ["-l"] : []), ...config.args, command];
}

function requirePanel(name: string): HostTarget {
  const target = readTarget(validateName(name));
  if (!target) throw new Error(`No panel named '${name}'. Use /panels to list panels.`);
  return target;
}

/** Native surfaces vanish when their server, window, or pane is destroyed elsewhere. */
async function isMissing(host: Host, target: HostTarget, signal?: AbortSignal): Promise<boolean> {
  return await host.state(target, signal).catch(() => undefined) === "missing";
}

async function readPanel(host: Host, target: HostTarget, lines: number, signal?: AbortSignal): Promise<string> {
  try {
    return snapshot(await host.read(target, lines, signal), lines);
  } catch (error) {
    signal?.throwIfAborted();
    if (await isMissing(host, target, signal)) {
      throw new Error(`Panel '${target.name}' no longer exists on ${target.host}. Close it and start a new one.`);
    }
    throw error;
  }
}

export default function panelsExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "panel-start",
    label: "Start Panel",
    description: "Start a long-running command in a named terminal panel: a server, watcher, or interactive program. The command runs in a bash login shell, the same shell as the bash tool. The name and output stay reserved until panel-close, including after the process exits. Use built-in bash for ordinary foreground commands.",
    parameters: Type.Object({
      name: nameSchema,
      command: Type.String({ minLength: 1 }),
      folder: Type.Optional(Type.String()),
    }),
    renderCall: (args) => renderToolCall("panel-start", args),
    async execute(_id, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const name = validateName(params.name);
      const cwd = resolveCwd(ctx.cwd, params.folder);
      const release = claimName(name);
      try {
        const existing = readTarget(name);
        if (existing) {
          // A panel whose native surface is gone holds no output; its name is free to reuse.
          if (!await isMissing(hostForTarget(pi, existing), existing, signal)) {
            throw new Error(`'${name}' already exists. Close it explicitly before reusing its name.`);
          }
          removeTarget(name);
        }
        // Hosts close their own half-created targets, so a failed start leaves nothing to clean up here.
        const host = getHost(pi);
        const target = await host.start({ kind: "shell", name, cwd, argv: panelArgv(params.command, ctx), placement: "worker", parent: host.parent() }, signal);
        saveTarget(target);
        return {
          content: [{ type: "text", text: `Started: ${identity(target)} in ${cwd}` }],
          details: { target, cwd, command: params.command },
        };
      } finally {
        release();
      }
    },
  });

  pi.registerTool({
    name: "panel-read",
    label: "Read Panel",
    description: "Read the most recent output of a panel, including one whose process has exited. Defaults to 500 lines, bounded to 2000 lines or 50KB. Reads are repeatable snapshots, not an incremental log.",
    parameters: Type.Object({ name: nameSchema, lines: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_LINES })) }),
    renderCall: (args) => renderToolCall("panel-read", args),
    async execute(_id, params, signal) {
      signal?.throwIfAborted();
      const target = requirePanel(params.name);
      const lines = params.lines ?? DEFAULT_LINES;
      const output = await readPanel(hostForTarget(pi, target), target, lines, signal);
      return { content: [{ type: "text", text: `${identity(target)}\n${output}` }], details: { target } };
    },
  });

  pi.registerTool({
    name: "panel-send",
    label: "Send to Panel",
    description: "Type a line of text or press native keys such as ctrl+c and Escape in a panel, then return its output. Supply exactly one of text or keys. This is terminal input, not draft-safe Pi prompt submission.",
    parameters: Type.Object({
      name: nameSchema,
      text: Type.Optional(Type.String()),
      keys: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
    }),
    renderCall: (args) => renderToolCall("panel-send", args),
    async execute(_id, params, signal) {
      signal?.throwIfAborted();
      if ((params.text === undefined) === (params.keys === undefined)) throw new Error("Supply exactly one of text or keys.");
      const target = requirePanel(params.name);
      const host = hostForTarget(pi, target);
      await host.send(target, params.text !== undefined
        ? { kind: "text", text: params.text, enter: true }
        : { kind: "keys", keys: params.keys! }, signal);
      await delay(SETTLE_MS, undefined, { signal });
      const output = await readPanel(host, target, DEFAULT_LINES, signal);
      return { content: [{ type: "text", text: `${identity(target)}\n${output}` }], details: { target } };
    },
  });

  pi.registerTool({
    name: "panel-close",
    label: "Close Panel",
    description: "Close a panel and release its name. A worker with an active parent request cannot be closed through this tool; cancel that request instead.",
    parameters: Type.Object({ name: nameSchema }),
    renderCall: (args) => renderToolCall("panel-close", args),
    async execute(_id, params, signal) {
      signal?.throwIfAborted();
      const release = claimName(params.name);
      try {
        const target = requirePanel(params.name);
        // Once close starts, finish cleanup even if the tool is cancelled.
        await hostForTarget(pi, target).close(target);
        removeTarget(params.name);
        return { content: [{ type: "text", text: `Closed ${identity(target)}.` }], details: { target } };
      } finally { release(); }
    },
  });

  pi.registerCommand("panels", {
    description: "List registered panels, workers, and interactive forks. Exited panels retain their names until explicitly closed.",
    async handler(_args, ctx) {
      const targets = listTargets();
      ctx.ui.notify(snapshot(targets.length
        ? targets.map((target) => `${identity(target)} ${target.kind} (${target.id})`).join("\n")
        : "No registered panels."), "info");
    },
  });
}
