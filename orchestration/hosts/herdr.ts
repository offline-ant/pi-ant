import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionAPI, ExecResult } from "@earendil-works/pi-coding-agent";
import type { Host, HostTarget } from "../host-types.ts";
import { TERMINAL_INPUT_EXTENSION, terminalRequest } from "../terminal-input.ts";

type JsonObject = Record<string, unknown>;
function object(value: unknown): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected a Herdr response object");
  return value as JsonObject;
}
function result(raw: string): JsonObject { return object(object(JSON.parse(raw)).result); }
function errorCode(response: ExecResult): string | undefined {
  for (const raw of [response.stdout, response.stderr]) {
    try {
      const code = object(object(JSON.parse(raw)).error).code;
      if (typeof code === "string") return code;
    } catch { /* A CLI diagnostic need not be JSON. */ }
  }
  return undefined;
}
function failure(response: ExecResult): Error {
  return new Error([response.stdout.trim(), response.stderr.trim()].filter(Boolean).join("\n") || "Herdr operation failed");
}
const quote = (text: string): string => `'${text.replaceAll("'", `'"'"'`)}'`;

export function createHerdrHost(pi: ExtensionAPI, endpoint: string): Host {
  const parentPane = process.env.HERDR_PANE_ID;
  const workspace = process.env.HERDR_WORKSPACE_ID;
  const binary = process.env.HERDR_BIN_PATH || "herdr";
  const run = (args: string[], signal?: AbortSignal) => pi.exec("env", [`HERDR_SOCKET_PATH=${endpoint}`, binary, ...args], { signal, timeout: 120_000 });
  async function checked(args: string[], signal?: AbortSignal): Promise<string> {
    const response = await run(args, signal);
    if (response.code !== 0 || response.killed) throw failure(response);
    return response.stdout;
  }
  const host: Host = {
    kind: "herdr", endpoint,
    parent: () => parentPane ? { host: "herdr", endpoint, id: parentPane, paneId: parentPane, name: "parent", kind: "pi" } : undefined,
    async start(spec, signal) {
      signal?.throwIfAborted();
      const parent = spec.parent;
      if (!parent || parent.host !== "herdr" || parent.endpoint !== endpoint) throw new Error("Herdr startup requires an explicit parent on the selected server");
      const env = spec.env ?? {};
      let create: string[];
      if (spec.placement === "interactive-fork") {
        const layout = object(result(await checked(["pane", "layout", "--pane", parent.paneId ?? parent.id], signal)).layout);
        const panes = Array.isArray(layout.panes) ? layout.panes.map(object) : [];
        const rect = object(panes.find((pane) => pane.pane_id === (parent.paneId ?? parent.id))?.rect);
        const direction = Number(rect.width) >= Number(rect.height) * 2 ? "right" : "down";
        create = ["pane", "split", parent.paneId ?? parent.id, "--direction", direction, "--cwd", spec.cwd, "--no-focus"];
      } else {
        const parentInfo = object(result(await checked(["pane", "get", parent.paneId ?? parent.id], signal)).pane);
        const workspaceId = typeof parentInfo.workspace_id === "string" ? parentInfo.workspace_id : workspace;
        if (!workspaceId) throw new Error("Could not identify the parent Herdr workspace");
        create = ["tab", "create", "--workspace", workspaceId, "--cwd", spec.cwd, "--label", spec.name, "--no-focus"];
      }
      const controlDir = fs.mkdtempSync(path.join(os.tmpdir(), spec.kind === "pi" ? "pi-terminal-" : "pi-panel-"));
      const controlPath = path.join(controlDir, spec.kind === "pi" ? "input.sock" : "exit-code");
      for (const [key, value] of Object.entries(env)) create.push("--env", `${key}=${value}`);
      if (spec.kind === "pi") create.push("--env", `PI_ORCHESTRATION_CONTROL=${controlPath}`);
      let target: HostTarget | undefined;
      try {
        const created = result(await checked(create));
        const pane = object(created.pane ?? created.root_pane);
        if (typeof pane.pane_id !== "string") throw new Error("Herdr did not return a pane identity");
        const paneId = pane.pane_id;
        target = { host: "herdr", endpoint, id: spec.kind === "pi" ? spec.name : paneId,
          paneId, name: spec.name, kind: spec.kind, controlPath, ...(spec.kind === "pi" ? { sessionFile: spec.sessionFile } : {}) };
        signal?.throwIfAborted();
        if (spec.kind === "pi") {
          const deadline = Date.now() + 5_000;
          while (true) {
            const response = await run(["agent", "start", spec.name, "--kind", "pi", "--pane", paneId,
              "--", "--session", spec.sessionFile, ...spec.args, "-e", TERMINAL_INPUT_EXTENSION], signal);
            if (response.code === 0) break;
            if (errorCode(response) !== "agent_pane_busy" || Date.now() >= deadline) throw failure(response);
            await delay(100, undefined, { signal });
          }
          const controlDeadline = Date.now() + 30_000;
          while (true) {
            signal?.throwIfAborted();
            try { await terminalRequest(controlPath!, { kind: "ping" }, signal); break; }
            catch (error) {
              if (Date.now() >= controlDeadline || await host.state(target, signal) !== "running") throw error;
              await delay(50, undefined, { signal });
            }
          }
          if (spec.prompt) await host.send(target, { kind: "prompt", text: spec.prompt }, signal);
        } else {
          // Herdr closes an exited terminal. Keep its interactive shell for
          // inspection, while tracking the actual command rather than that shell.
          // The launch file also keeps readiness needles out of terminal echo.
          const launchFile = path.join(controlDir, "start.sh");
          const pidFile = path.join(controlDir, "pid");
          fs.writeFileSync(launchFile, [
            `printf '%s' "$$" > ${quote(pidFile)}`,
            `rm -- ${quote(launchFile)}`,
            `/bin/sh -lc ${quote(spec.command)}`,
            `printf '%s' "$?" > ${quote(controlPath)}`,
          ].join("\n") + "\n", { mode: 0o600 });
          await checked(["pane", "run", paneId, `/bin/sh ${quote(launchFile)}`], signal);
          const deadline = Date.now() + 5_000;
          while (fs.existsSync(launchFile)) {
            if (Date.now() >= deadline || await host.state(target, signal) !== "running") {
              throw new Error(`Herdr shell did not start: ${paneId}`);
            }
            await delay(50, undefined, { signal });
          }
        }
        signal?.throwIfAborted();
        return target;
      } catch (error) {
        if (target) await host.close(target).catch(() => undefined);
        else if (controlDir) fs.rmSync(controlDir, { recursive: true, force: true });
        throw error;
      }
    },
    async send(target, input, signal) {
      if (input.kind === "prompt") {
        if (target.kind !== "pi" || !target.controlPath) throw new Error("Pi prompt submission requires its owned terminal input endpoint");
        // Herdr 0.8.2 agent prompt appends to an existing draft, just like terminal paste.
        await terminalRequest(target.controlPath, input, signal);
      } else if (input.kind === "text") {
        await checked(["pane", input.enter ? "run" : "send-text", target.paneId ?? target.id, input.text], signal);
      } else {
        await checked(["pane", "send-keys", target.paneId ?? target.id, ...input.keys], signal);
      }
    },
    async read(target, lines = 80, signal) {
      const pane = target.paneId ?? target.id;
      const info = object(result(await checked(["pane", "get", pane], signal)).pane);
      const rows = typeof info.scroll === "object" && info.scroll !== null ? Number(object(info.scroll).viewport_rows ?? 0) : 0;
      const snapshot = await checked(["pane", "read", pane, "--source", "recent", "--lines", String(lines + rows)], signal);
      return snapshot.trimEnd().split("\n").slice(-lines).join("\n");
    },
    async state(target, signal) {
      const pane = target.paneId ?? target.id;
      const response = await run(["pane", "get", pane], signal);
      signal?.throwIfAborted();
      if (response.code !== 0) {
        if (["pane_not_found", "terminal_not_found"].includes(errorCode(response) ?? "")) return "missing";
        throw failure(response);
      }
      if (target.kind === "pi") {
        const agent = await run(["agent", "get", target.id], signal);
        signal?.throwIfAborted();
        if (agent.code !== 0) {
          if (errorCode(agent) === "agent_not_found") return "exited";
          throw failure(agent);
        }
        const info = object(result(agent.stdout).agent ?? result(agent.stdout).pane);
        return info.agent === "pi" ? "running" : "exited";
      }
      if (target.controlPath && fs.existsSync(target.controlPath)) return "exited";
      const pidFile = target.controlPath ? path.join(path.dirname(target.controlPath), "pid") : undefined;
      if (pidFile && fs.existsSync(pidFile)) {
        try { process.kill(Number(fs.readFileSync(pidFile, "utf8")), 0); return "running"; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") return "exited";
          throw error;
        }
      }
      const processInfo = object(result(await checked(["pane", "process-info", "--pane", pane], signal)).process_info);
      return Array.isArray(processInfo.foreground_processes) && processInfo.foreground_processes.length > 0 ? "running" : "exited";
    },
    async close(target, signal) {
      const response = await run(["pane", "close", target.paneId ?? target.id], signal);
      if (response.code !== 0 && !["pane_not_found", "terminal_not_found"].includes(errorCode(response) ?? "")) throw failure(response);
      if (target.controlPath) fs.rmSync(path.dirname(target.controlPath), { recursive: true, force: true });
    },
  };
  return host;
}
