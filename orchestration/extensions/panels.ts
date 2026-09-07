import { setTimeout as delay } from "node:timers/promises";
import { truncateTail, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { resolveCwd } from "../context.ts";
import { getHost, hostForTarget } from "../host.ts";
import type { Host, HostTarget } from "../host-types.ts";
import { claimName, listTargets, readTarget, removeTarget, saveTarget, validateName } from "../workers.ts";

const MAX_LINES = 2000;
const MAX_BYTES = 50 * 1024;
const DEFAULT_READY_TIMEOUT_MS = 30_000;
const waitForSchema = Type.Object({
  match: Type.String({ minLength: 1 }),
  regex: Type.Optional(Type.Boolean()),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1, description: "Readiness deadline in milliseconds; defaults to 30000." })),
});
const nameSchema = Type.String({ description: "Registered logical name, not a native pane or buffer ID." });

function identity(target: HostTarget): string {
  return `${target.name} (${target.host}:${target.id}; endpoint: ${target.endpoint})`;
}

function snapshot(text: string, lines = MAX_LINES): string {
  const result = truncateTail(text, { maxLines: lines, maxBytes: MAX_BYTES });
  return (result.content || "(no output)") + (result.truncated
    ? "\n[Snapshot truncated to the last requested lines or 50KB; inspect the native panel for earlier output.]"
    : "");
}

function requireTarget(name: string): HostTarget {
  const target = readTarget(validateName(name));
  if (!target) throw new Error(`No registered panel named '${name}'. Use /panels to list targets.`);
  return target;
}

async function waitUntilReady(
  host: Host,
  target: HostTarget,
  waitFor: Static<typeof waitForSchema>,
  pattern: RegExp | undefined,
  signal?: AbortSignal,
): Promise<string> {
  const timeoutMs = waitFor.timeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const timeout = AbortSignal.timeout(timeoutMs);
  const waiting = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let recent = "(no output captured)";
  try {
    while (true) {
      waiting.throwIfAborted();
      const output = await host.read(target, MAX_LINES, waiting);
      recent = snapshot(output);
      waiting.throwIfAborted();
      if (pattern ? pattern.test(output) : output.includes(waitFor.match)) return recent;
      const state = await host.state(target, waiting);
      if (state !== "running") throw new Error(`Process ${state} before readiness matched.`);
      await delay(100, undefined, { signal: waiting });
    }
  } catch (error) {
    signal?.throwIfAborted();
    const reason = timeout.aborted ? `Readiness timed out after ${timeoutMs}ms.` : String(error);
    throw new Error(`${reason}\nPanel retained: ${identity(target)}\nUse panel-read or panel-close with name '${target.name}'.\nRecent output:\n${recent}`);
  }
}

export default function panelsExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "panel-start",
    label: "Start Panel",
    description: "Start a named terminal panel for a server, watcher, build, or interactive command. Optional waitFor checks readiness, not task completion. Readiness failures retain the panel and recent output; cancellation closes the newly created panel. Names remain reserved until panel-close, even after process exit. Use built-in bash for ordinary foreground commands.",
    parameters: Type.Object({
      name: nameSchema,
      command: Type.String({ minLength: 1 }),
      folder: Type.Optional(Type.String()),
      waitFor: Type.Optional(waitForSchema),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const name = validateName(params.name);
      const cwd = resolveCwd(ctx.cwd, params.folder);
      const pattern = params.waitFor?.regex ? new RegExp(params.waitFor.match) : undefined;
      const release = claimName(name);
      let target: HostTarget | undefined;
      let registered = false;
      try {
        if (readTarget(name)) throw new Error(`'${name}' already exists. Close it explicitly before reusing its name.`);
        const host = getHost(pi);
        target = await host.start({ kind: "shell", name, cwd, command: params.command, placement: "worker", parent: host.parent() }, signal);
        signal?.throwIfAborted();
        saveTarget(target);
        registered = true;
        const output = params.waitFor ? await waitUntilReady(host, target, params.waitFor, pattern, signal) : undefined;
        signal?.throwIfAborted();
        return {
          content: [{ type: "text", text: `${params.waitFor ? "Ready" : "Started"}: ${identity(target)}\nCwd: ${cwd}${output === undefined ? "" : `\n${output}`}` }],
          details: { target, cwd, command: params.command, ready: params.waitFor !== undefined },
        };
      } catch (error) {
        if (target && (!registered || signal?.aborted)) {
          try {
            await hostForTarget(pi, target).close(target);
            removeTarget(name);
          } catch (closeError) {
            // Preserve the handle when native cleanup fails so recovery remains possible.
            if (!registered) saveTarget(target);
            throw new Error(`${String(error)}\nCould not close ${identity(target)}: ${String(closeError)}`);
          }
        }
        throw error;
      } finally {
        release();
      }
    },
  });

  pi.registerTool({
    name: "panel-read",
    label: "Read Panel",
    description: "Read a bounded snapshot from a registered panel or worker, including exited shell panels. Defaults to 500 lines; limited to 2000 lines or 50KB. Repeated reads may overlap: this is not an incremental or lossless output log.",
    parameters: Type.Object({ name: nameSchema, lines: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_LINES })) }),
    async execute(_id, params, signal) {
      signal?.throwIfAborted();
      const target = requireTarget(params.name);
      const lines = params.lines ?? 500;
      const output = await hostForTarget(pi, target).read(target, lines, signal);
      return { content: [{ type: "text", text: `${identity(target)}\n${snapshot(output, lines)}` }], details: { target } };
    },
  });

  pi.registerTool({
    name: "panel-send",
    label: "Send to Panel",
    description: "Send literal terminal text or native key presses to a registered target. Supply exactly one of text or keys. Text presses Enter by default; enter is valid only with text. This is terminal input, not draft-safe Pi prompt submission.",
    parameters: Type.Object({
      name: nameSchema,
      text: Type.Optional(Type.String()),
      keys: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
      enter: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, params, signal) {
      signal?.throwIfAborted();
      if ((params.text === undefined) === (params.keys === undefined)) throw new Error("Supply exactly one of text or keys.");
      if (params.keys && params.enter !== undefined) throw new Error("enter is only valid with text.");
      const target = requireTarget(params.name);
      await hostForTarget(pi, target).send(target, params.text !== undefined
        ? { kind: "text", text: params.text, enter: params.enter ?? true }
        : { kind: "keys", keys: params.keys! }, signal);
      return { content: [{ type: "text", text: `Sent to ${identity(target)}.` }], details: { target } };
    },
  });

  pi.registerTool({
    name: "panel-close",
    label: "Close Panel",
    description: "Close a registered target and release its name. Finished shell panels retain their output until explicitly closed. A worker with an active parent request cannot be closed through this tool; cancel that request instead.",
    parameters: Type.Object({ name: nameSchema }),
    async execute(_id, params, signal) {
      signal?.throwIfAborted();
      const release = claimName(params.name);
      try {
        const target = requireTarget(params.name);
        // Once close starts, finish cleanup even if the tool is cancelled.
        await hostForTarget(pi, target).close(target);
        removeTarget(params.name);
        return { content: [{ type: "text", text: `Closed ${identity(target)}.` }], details: { target } };
      } finally { release(); }
    },
  });

  pi.registerCommand("panels", {
    description: "List registered panels, workers, and interactive forks. Exited targets retain their names until explicitly closed.",
    async handler(_args, ctx) {
      const targets = listTargets();
      ctx.ui.notify(snapshot(targets.length ? targets.map((target) => `${identity(target)} [${target.kind}]`).join("\n") : "No registered panels."), "info");
    },
  });
}
