import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import type { ExtensionAPI, ExecOptions } from "@earendil-works/pi-coding-agent";
import type { HostTarget } from "../host-types.ts";
import { createHerdrHost } from "./herdr.ts";
import { createTmuxHost } from "./tmux.ts";

const exec = promisify(execFile);
const fixture = fileURLToPath(new URL("../test/terminal-fixture.ts", import.meta.url));
const native = process.env.PI_NATIVE_HOST_SMOKE === "1";
const pi = {
  async exec(command: string, args: string[], options: ExecOptions = {}) {
    try {
      return { ...await exec(command, args, { timeout: options.timeout, signal: options.signal }), code: 0, killed: false };
    } catch (error) {
      const failure = error as Error & { stdout?: string; stderr?: string; code?: number; killed?: boolean };
      return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? failure.message, code: failure.code ?? 1, killed: failure.killed ?? false };
    }
  },
} as unknown as ExtensionAPI;

for (const kind of ["tmux", "herdr"] as const) {
  test(`${kind} native Pi draft, startup prompt, process death and terminal keys`, {
    skip: !native || (kind === "herdr" && !process.env.HERDR_SOCKET_PATH),
    timeout: 120_000,
  }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-native-smoke-"));
    const endpoint = kind === "tmux" ? path.join(dir, "tmux.sock") : process.env.HERDR_SOCKET_PATH!;
    let parent: HostTarget | undefined;
    const host = kind === "tmux" ? createTmuxHost(pi, endpoint) : createHerdrHost(pi, endpoint);
    if (kind === "tmux") {
      await exec("tmux", ["-S", endpoint, "new-session", "-d", "-s", "smoke", "-x", "110", "-y", "35"]);
      const pane = (await exec("tmux", ["-S", endpoint, "display-message", "-p", "-t", "smoke", "#{pane_id}"])).stdout.trim();
      parent = { host: kind, endpoint, id: pane, paneId: pane, name: "parent", kind: "pi" };
    } else parent = host.parent();
    const sessionFile = path.join(dir, "session.jsonl");
    fs.writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: randomUUID(), timestamp: new Date().toISOString(), cwd: dir })}\n`);
    const report = path.join(dir, "report.json");
    try {
      const target = await host.start({ kind: "pi", name: `native-${randomUUID().slice(0, 8)}`, cwd: dir, sessionFile,
        args: ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "-e", fixture],
        env: { PI_NATIVE_REPORT: report }, prompt: "/native-report", placement: "interactive-fork", parent });
      try {
        for (let attempt = 0; attempt < 50 && !fs.existsSync(report); attempt++) await delay(100);
        assert.deepEqual(JSON.parse(fs.readFileSync(report, "utf8")), { draft: "", session: sessionFile });
        fs.rmSync(report);
        assert.equal(await host.state(target), "running");
        await host.send(target, { kind: "text", text: "human draft unchanged", enter: false });
        await delay(200);
        await host.send(target, { kind: "prompt", text: "/native-report" });
        for (let attempt = 0; attempt < 50 && !fs.existsSync(report); attempt++) await delay(100);
        assert.deepEqual(JSON.parse(fs.readFileSync(report, "utf8")), { draft: "human draft unchanged", session: sessionFile });
        assert.ok((await host.read(target, 20)).includes("human draft unchanged"));
        await host.send(target, { kind: "prompt", text: "/native-exit" });
        for (let attempt = 0; attempt < 50 && await host.state(target) === "running"; attempt++) await delay(100);
        assert.notEqual(await host.state(target), "running");
      } finally { await host.close(target); }

      const shell = await host.start({ kind: "shell", name: `shell-${randomUUID().slice(0, 8)}`, cwd: dir,
        command: 'printf "NATIVE_READY\\n"; /bin/cat', placement: "worker", parent });
      try {
        for (let attempt = 0; attempt < 30; attempt++) {
          if ((await host.read(shell, 30)).includes("NATIVE_READY")) break;
          await delay(100);
        }
        await host.send(shell, { kind: "text", text: "Enter literal text", enter: true });
        await delay(200);
        assert.ok((await host.read(shell, 30)).includes("Enter literal text"));
        await host.send(shell, { kind: "keys", keys: ["ctrl+c"] });
      } finally { await host.close(shell); }

      const instant = await host.start({ kind: "shell", name: `instant-${randomUUID().slice(0, 8)}`, cwd: dir,
        command: 'printf "INSTANT_OUTPUT\\n"', placement: "worker", parent });
      try {
        await delay(200);
        assert.ok((await host.read(instant, 80)).includes("INSTANT_OUTPUT"));
        assert.notEqual(await host.state(instant), "running");
      } finally { await host.close(instant); }
    } finally {
      if (kind === "tmux") await exec("tmux", ["-S", endpoint, "kill-server"]);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
