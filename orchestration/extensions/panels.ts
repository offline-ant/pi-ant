import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { getAgentDir, getShellConfig, SettingsManager, truncateTail, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resolveCwd } from "../context.ts";
import { getHost, hostForTarget } from "../host.ts";
import type { Host, HostTarget } from "../host-types.ts";
import { capturedArgv, capturedExitStatus, commandOutput, createPanelOutput, promptReporting, promptWarning, readCursor, recordInput, removePanelOutput, scanOutput, SHELL_INTEGRATION, writeCursor } from "../panel-output.ts";
import { renderToolCall } from "../tool-call.ts";
import { claimName, listTargets, readTarget, removeTarget, saveTarget, validateName } from "../workers.ts";

const MAX_LINES = 2000;
const MAX_BYTES = 50 * 1024;
const DEFAULT_LINES = 500;
/** Terminals answer input asynchronously; settle briefly so the returned snapshot shows the effect. */
const SETTLE_MS = 250;
/** How long a line typed at a shell prompt may run before panel-send returns without its result. */
const COMMAND_GRACE_MS = 5000;
const POLL_MS = 100;
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

type CommandProgress =
  | { kind: "finished"; end: number; status?: number }
  | { kind: "exited"; status?: number }
  | { kind: "running" };

/** Follow a line typed at a shell prompt until its command ends, the panel's command exits, or the grace runs out. */
async function followCommand(log: string, input: number, graceMs: number, signal?: AbortSignal): Promise<CommandProgress> {
  const deadline = Date.now() + graceMs;
  let offset = input;
  for (;;) {
    const scan = scanOutput(log, offset, undefined, input);
    offset = scan.next;
    if (scan.found?.outcome.kind === "prompt") {
      const { status } = scan.found.outcome;
      return { kind: "finished", end: scan.found.end, ...(status !== undefined ? { status } : {}) };
    }
    if (scan.exitStatus !== undefined) return { kind: "exited", status: scan.exitStatus };
    if (scan.more) continue;
    if (Date.now() >= deadline) return { kind: "running" };
    await delay(POLL_MS, undefined, { signal });
  }
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

/** Native surfaces vanish when their server, window, or pane is destroyed elsewhere. */
async function isMissing(host: Host, target: HostTarget, signal?: AbortSignal): Promise<boolean> {
  return await host.state(target, signal).catch(() => undefined) === "missing";
}

const missingError = (target: HostTarget): Error =>
  new Error(`Panel '${target.name}' no longer exists on ${target.host}. Close it and start a new one.`);

async function readPanel(host: Host, target: HostTarget, lines: number, signal?: AbortSignal): Promise<string> {
  try {
    return snapshot(await host.read(target, lines, signal), lines);
  } catch (error) {
    signal?.throwIfAborted();
    if (await isMissing(host, target, signal)) throw missingError(target);
    throw error;
  }
}

/**
 * Input to a shell panel needs its command running: once it exits, a tmux pane is
 * dead and Herdr's pane holds its own uncaptured shell, so input reaches nothing useful.
 */
async function requireRunning(host: Host, target: HostTarget, signal?: AbortSignal): Promise<void> {
  if (target.kind !== "shell") return;
  const state = await host.state(target, signal);
  if (state === "missing") throw missingError(target);
  if (state === "running") return;
  const status = target.outputPath ? capturedExitStatus(target.outputPath) : undefined;
  throw new Error(`The command of panel '${target.name}' exited${status !== undefined ? ` with status ${status}` : ""}; its output is no longer captured and input would reach nothing useful. `
    + "Read its final output with panel-read, then close it and start a new panel. To run several commands in sequence, start a panel whose command is an interactive shell and send each command to it.");
}

export default function panelsExtension(pi: ExtensionAPI, commandGraceMs = COMMAND_GRACE_MS): void {
  /** Prompt-mark warnings already shown to the user, once per panel and running program. */
  const notified = new Set<string>();
  pi.registerTool({
    name: "panel-start",
    label: "Start Panel",
    description: "Start a long-running command in a named terminal panel: a server, watcher, or interactive program. The command runs in the bash tool's shell (a login shell when that is bash). "
      + "After the command exits, its output stays readable and its name reserved until panel-close, but the panel accepts no more input. "
      + `To run several commands in sequence, start an interactive shell that reports its prompt with OSC 133 marks (\`fish\` 4+, or \`bash --rcfile ${SHELL_INTEGRATION.bash} -i\`) and send each command with panel-send, which then returns its output and exit status; wait also works. `
      + "Use built-in bash for ordinary foreground commands. Use wait, never sleep, to react when its output, shell prompt, or exit is ready.",
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
          removePanelOutput(existing.outputPath);
        }
        // Hosts close their own half-created targets; only the output capture is ours to remove.
        const host = getHost(pi);
        const output = createPanelOutput();
        let target: HostTarget;
        try {
          target = { ...await host.start({ kind: "shell", name, cwd, argv: capturedArgv(panelArgv(params.command, ctx), output.log), placement: "worker", parent: host.parent() }, signal), outputPath: output.log };
        } catch (error) {
          removePanelOutput(output.log);
          throw error;
        }
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
      const host = hostForTarget(pi, target);
      const output = await readPanel(host, target, lines, signal);
      // A shell idle at its prompt is not running a command worth waiting for.
      const running = target.kind === "shell" && target.outputPath !== undefined
        && promptReporting(target.outputPath, fs.statSync(target.outputPath).size).kind !== "prompt"
        && await host.state(target, signal) === "running";
      const hint = running ? "\n\nThe command is still running; use wait to react to new output, its prompt, or exit instead of reading again." : "";
      return { content: [{ type: "text", text: `${identity(target)}\n${output}${hint}` }], details: { target } };
    },
  });

  pi.registerTool({
    name: "panel-send",
    label: "Send to Panel",
    description: "Type a line of text or press native keys such as ctrl+c and Escape in a panel, then return its output. Supply exactly one of text or keys. A panel whose command has exited accepts no input. "
      + `Text typed at a shell prompt that emits OSC 133 prompt marks (also over ssh) returns that command's exit status and full output when it finishes within ${commandGraceMs / 1000} seconds; a longer command returns the panel screen, so follow it with wait. `
      + "Keys and input to a running program return the screen shortly afterwards. This is terminal input, not draft-safe Pi prompt submission. Text sent where no shell reports its prompt, such as ssh to a host without shell integration, returns a warning: wait without match cannot see it finish.",
    parameters: Type.Object({
      name: nameSchema,
      text: Type.Optional(Type.String()),
      keys: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
    }),
    renderCall: (args) => renderToolCall("panel-send", args),
    async execute(_id, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      if ((params.text === undefined) === (params.keys === undefined)) throw new Error("Supply exactly one of text or keys.");
      const target = requirePanel(params.name);
      const host = hostForTarget(pi, target);
      await requireRunning(host, target, signal);
      const log = target.outputPath;
      // Only a shell idle at its prompt reports when a typed line is done.
      const atPrompt = params.text !== undefined && log !== undefined && promptReporting(log, fs.statSync(log).size).kind === "prompt";
      const input = log ? recordInput(log) : undefined;
      const sentAt = Date.now();
      await host.send(target, params.text !== undefined
        ? { kind: "text", text: params.text, enter: true }
        : { kind: "keys", keys: params.keys! }, signal);
      let note = "";
      let outcome: CommandProgress["kind"] | undefined;
      if (atPrompt && log !== undefined && input !== undefined) {
        const progress = await followCommand(log, input, commandGraceMs, signal);
        const elapsed = seconds(Date.now() - sentAt);
        if (progress.kind === "finished") {
          // The result already shows this output; later waits continue after it.
          writeCursor(log, { ...readCursor(log), cursor: progress.end });
          // A nested shell's first prompt (ssh) also ends the line that started it.
          const summary = `Back at the shell prompt after ${elapsed}${progress.status !== undefined ? ` (exit status ${progress.status})` : ""}. Output:`;
          return {
            content: [{ type: "text", text: `${identity(target)}\n${summary}\n${snapshot(commandOutput(log, input, progress.end))}` }],
            details: { target, outcome: progress.kind, ...(progress.status !== undefined ? { status: progress.status } : {}) },
          };
        }
        outcome = progress.kind;
        note = progress.kind === "exited"
          ? `The panel's command exited${progress.status !== undefined ? ` with status ${progress.status}` : ""}.`
          : `Still running after ${elapsed}; use wait to follow it. Panel screen:`;
      } else {
        await delay(SETTLE_MS, undefined, { signal });
      }
      const output = await readPanel(host, target, DEFAULT_LINES, signal);
      // Keys usually interrupt or answer a running program; only typed lines are commands to wait for.
      let warning: string | undefined;
      if (params.text !== undefined && input !== undefined && log !== undefined) {
        const reporting = promptReporting(log, fs.statSync(log).size, input);
        warning = promptWarning(reporting);
        const key = `${log}:${reporting.kind}:${reporting.kind === "program" ? reporting.mark : ""}`;
        if (warning && ctx.hasUI && !notified.has(key)) {
          notified.add(key);
          ctx.ui.notify(`Panel ${target.name}: ${warning}`, "warning");
        }
      }
      return {
        content: [{ type: "text", text: `${identity(target)}\n${note ? `${note}\n` : ""}${output}${warning ? `\n\n${warning}` : ""}` }],
        details: { target, ...(outcome ? { outcome } : {}) },
      };
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
        removePanelOutput(target.outputPath);
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
