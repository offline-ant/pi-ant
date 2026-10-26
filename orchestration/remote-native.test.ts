import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { loadRemoteContext } from "./remote-context.ts";
import { RemoteSession, resolveRemoteLocation } from "./remote-session.ts";
import { createRemoteToolDefinitions } from "./remote-tools.ts";
import { remoteTerminalArgv, shellQuote, sshControlDirectory, sshRun } from "./ssh.ts";

/**
 * Opt-in: PI_REMOTE_NATIVE=1 [PI_REMOTE_NATIVE_TARGET=user@host] runs the remote
 * tools against a real sshd (default `localhost`) with key authentication. It
 * creates and removes one temporary directory on that host.
 */
const enabled = process.env.PI_REMOTE_NATIVE === "1";
const destination = process.env.PI_REMOTE_NATIVE_TARGET || "localhost";
type AnyTool = ToolDefinition<any, any, any>;
type Result = { content: Array<{ type: string; text?: string }>; isError?: boolean };
const text = (result: Result) => result.content.map((item) => item.text ?? "").join("\n");

test("real ssh: tools, process-group cancellation, context and terminal panels", { skip: !enabled, timeout: 120_000 }, async (t) => {
  const made = await sshRun(destination, "mktemp -d \"${TMPDIR:-/tmp}/pi-remote-native.XXXXXX\"");
  assert.equal(made.code, 0, made.stderr);
  const root = made.stdout.toString().trim();
  t.after(async () => { await sshRun(destination, `rm -rf -- ${shellQuote(root)}`); });
  await sshRun(destination, `mkdir -p ${shellQuote(`${root}/proj/src`)} && printf 'native rules' > ${shellQuote(`${root}/AGENTS.md`)}`);

  const location = await resolveRemoteLocation({ destination, path: root }, "proj");
  assert.equal(location.cwd, `${root}/proj`);
  assert.ok(fs.readdirSync(sshControlDirectory()).length > 0, "a multiplexing control socket exists");

  const definitions = new Map(createRemoteToolDefinitions(new RemoteSession(`${destination}:${location.cwd}`), process.cwd()).map((tool: AnyTool) => [tool.name, tool]));
  const ctx = { cwd: process.cwd(), model: undefined } as unknown as Parameters<AnyTool["execute"]>[4];
  const run = (name: string, params: Record<string, unknown>, signal?: AbortSignal, onText?: (value: string) => void) =>
    definitions.get(name)!.execute(name, params, signal, (update) => onText?.(text(update as Result)), ctx) as Promise<Result>;

  const content = "binary-safe ' \" $(x) `y` \\ ü\u0000\n";
  await run("write", { path: "src/a.ts", content });
  assert.equal(text(await run("read", { path: "src/a.ts" })), content);
  await run("edit", { path: "src/a.ts", edits: [{ oldText: "binary-safe", newText: "edited" }] });
  assert.match(text(await run("bash", { command: "cat src/a.ts; pwd" })), new RegExp(`^edited[^]*\\n${location.cwd}\\n$`));
  assert.equal(text(await run("ls", { path: "." })), "src/");
  assert.equal(text(await run("find", { pattern: "*.ts" })), "src/a.ts");

  const controller = new AbortController();
  const pending = run("bash", { command: `sleep 120 & echo "$! $$" > pids; echo started; sleep 120` }, controller.signal,
    (output) => { if (output.includes("started")) controller.abort(); });
  await assert.rejects(pending, /Command aborted/);
  const pids = text(await run("bash", { command: "cat pids" })).trim();
  let alive = "";
  for (let attempt = 0; attempt < 50; attempt++) {
    alive = text(await run("bash", { command: `for p in ${pids}; do kill -0 "$p" 2>/dev/null && echo "$p"; done; true` })).replace("(no output)", "").trim();
    if (!alive) break;
    await delay(100);
  }
  assert.equal(alive, "", "remote foreground and background processes are terminated");
  await assert.rejects(run("bash", { command: "sleep 30", timeout: 1 }), /timed out after 1 seconds/);

  const context = await loadRemoteContext(location);
  assert.ok(context.contextFiles.some((file) => file.path === `${root}/AGENTS.md` && file.content === "native rules"));

  const argv = remoteTerminalArgv(destination, location.cwd, "pwd; [ -t 0 ] && echo has-tty");
  const terminal = spawnSync("script", ["-qec", argv.map(shellQuote).join(" "), "/dev/null"], { encoding: "utf8", timeout: 30_000 });
  assert.match(terminal.stdout, new RegExp(`${location.cwd}\\r?\\nhas-tty`));
});
