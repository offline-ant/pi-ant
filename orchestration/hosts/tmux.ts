import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Host, HostTarget } from "../host-types.ts";

import { TERMINAL_INPUT_EXTENSION, terminalRequest } from "../terminal-input.ts";
const quote = (text: string): string => `'${text.replaceAll("'", `'"'"'`)}'`;

function tmuxKey(key: string): string {
  return key.replace(/ctrl\+/ig, "C-").replace(/alt\+/ig, "M-").replace(/shift\+/ig, "S-");
}

export function createTmuxHost(pi: ExtensionAPI, endpoint: string): Host {
  const parentPane = process.env.TMUX_PANE;
  const run = (args: string[], signal?: AbortSignal) => pi.exec("tmux", ["-S", endpoint, ...args], { signal, timeout: 30_000 });
  async function checked(args: string[], signal?: AbortSignal): Promise<string> {
    const result = await run(args, signal);
    if (result.code !== 0 || result.killed) throw new Error(result.stderr.trim() || result.stdout.trim() || `tmux ${args[0]} failed`);
    return result.stdout;
  }
  const host: Host = {
    kind: "tmux", endpoint,
    parent: () => parentPane ? { host: "tmux", endpoint, id: parentPane, paneId: parentPane, kind: "pi", name: "parent" } : undefined,
    async start(spec, signal) {
      signal?.throwIfAborted();
      const parent = spec.parent;
      if (!parent || parent.host !== "tmux" || parent.endpoint !== endpoint) throw new Error("Tmux startup requires an explicit parent on the selected server");
      const session = spec.placement === "worker"
        ? (await checked(["display-message", "-p", "-t", parent.id, "#{session_id}"], signal)).trim()
        : undefined;
      let controlPath: string | undefined;
      let controlDir: string | undefined;
      if (spec.kind === "pi") {
        controlDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-terminal-"));
        controlPath = path.join(controlDir, "input.sock");
      }
      const env = { ...spec.env, ...(controlPath ? { PI_ORCHESTRATION_CONTROL: controlPath } : {}) };
      const launch = spec.kind === "pi"
        ? ["exec", "pi", "--session", spec.sessionFile, ...spec.args, "-e", TERMINAL_INPUT_EXTENSION].map((arg, index) => index === 0 ? arg : quote(arg)).join(" ")
        : `exec /bin/sh -lc ${quote(spec.command)}`;
      const args = spec.placement === "interactive-fork"
        ? ["split-window", "-d", "-t", parent.id, "-P", "-F", "#{pane_id}", "-c", spec.cwd]
        : ["new-window", "-d", "-t", session!, "-n", spec.name, "-P", "-F", "#{pane_id}", "-c", spec.cwd];
      for (const [key, value] of Object.entries(env)) args.push("-e", `${key}=${value}`);
      // Set the owned pane option before exec, so even an immediate command exit retains its output.
      const command = `tmux -S ${quote(endpoint)} set-option -p -t "$TMUX_PANE" remain-on-exit on && ${launch}`;
      args.push("/bin/sh", "-lc", command);
      let target: HostTarget | undefined;
      try {
        const id = (await checked(args)).trim();
        if (!/^%\d+$/.test(id)) throw new Error(`Invalid tmux pane identity: ${id}`);
        target = { host: "tmux", endpoint, id, paneId: id, name: spec.name, kind: spec.kind,
          ...(spec.kind === "pi" ? { sessionFile: spec.sessionFile, controlPath } : {}) };
        if (spec.kind === "pi") {
          const deadline = Date.now() + 30_000;
          while (true) {
            signal?.throwIfAborted();
            try { await terminalRequest(controlPath!, { kind: "ping" }, signal); break; }
            catch (error) {
              if (Date.now() >= deadline || await host.state(target, signal) !== "running") throw error;
              await delay(50, undefined, { signal });
            }
          }
          if (spec.prompt) await host.send(target, { kind: "prompt", text: spec.prompt }, signal);
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
        await terminalRequest(target.controlPath, input, signal);
      } else if (input.kind === "text") {
        await checked(["send-keys", "-t", target.id, "-l", "--", input.text], signal);
        if (input.enter) await checked(["send-keys", "-t", target.id, "Enter"], signal);
      } else {
        await checked(["send-keys", "-t", target.id, ...input.keys.map(tmuxKey)], signal);
      }
    },
    async read(target, lines = 80, signal) {
      const snapshot = await checked(["capture-pane", "-p", "-t", target.id, "-S", `-${Math.max(1, lines)}`], signal);
      return snapshot.trimEnd().split("\n").slice(-Math.max(1, lines)).join("\n");
    },
    async state(target, signal) {
      const result = await run(["display-message", "-p", "-t", target.id, "#{pane_dead}"], signal);
      signal?.throwIfAborted();
      if (result.code !== 0 || result.stdout.trim() === "") return "missing";
      return result.stdout.trim() === "1" ? "exited" : "running";
    },
    async close(target, signal) {
      if (await host.state(target, signal) !== "missing") await checked(["kill-pane", "-t", target.id], signal);
      if (target.controlPath) fs.rmSync(path.dirname(target.controlPath), { recursive: true, force: true });
    },
  };
  return host;
}
