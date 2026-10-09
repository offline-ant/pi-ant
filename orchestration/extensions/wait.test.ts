import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import test, { after, before } from "node:test";
import type { ExecOptions, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { capturedArgv, SHELL_INTEGRATION } from "../panel-output.ts";
import { removeTarget } from "../workers.ts";
import panelsExtension from "./panels.ts";
import waitExtension from "./wait.ts";

const run = promisify(execFile);
function has(command: string): boolean {
  try { execFileSync("/bin/sh", ["-c", `command -v ${command}`], { stdio: "ignore" }); return true; }
  catch { return false; }
}
const fishMajor = has("fish") ? Number(/(\d+)\./.exec(execFileSync("fish", ["--version"], { encoding: "utf8" }))?.[1] ?? 0) : 0;
/** Herdr runs the same tests natively when explicitly requested from inside a Herdr pane. */
const herdr = process.env.PI_NATIVE_HOST_SMOKE === "1" && process.env.HERDR_ENV === "1" && !!process.env.HERDR_SOCKET_PATH && !!process.env.HERDR_PANE_ID;
/** A short panel-send grace keeps tests of running commands quick. */
const GRACE_MS = 1500;
const skip = process.platform !== "linux" || !has("script") || (!herdr && !has("tmux")) ? "requires Linux, tmux or Herdr, and util-linux script" : false;

interface Result { content: Array<{ type: string; text: string }>; details: { outcome?: string; status?: number; line?: string } }
type Execute = (id: string, params: Record<string, unknown>, signal: AbortSignal | undefined, update: undefined, ctx: ExtensionContext) => Promise<Result>;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-test-"));
const endpoint = herdr ? process.env.HERDR_SOCKET_PATH! : path.join(dir, "tmux.sock");
const agentDir = path.join(dir, "agent");
const envKeys = ["PI_ORCHESTRATION_HOST", "PI_ORCHESTRATION_ENDPOINT", "TMUX_PANE", "TMUX", "PI_CODING_AGENT_DIR", "HERDR_ENV"];
const previous = envKeys.map((key) => process.env[key]);
const tools = new Map<string, Execute>();
const names: string[] = [];
const pi = {
  registerTool: (tool: { name: string; execute: Execute }) => tools.set(tool.name, tool.execute),
  registerCommand: () => undefined,
  async exec(command: string, args: string[], options: ExecOptions = {}) {
    try {
      return { ...await run(command, args, { timeout: options.timeout, signal: options.signal }), code: 0, killed: false };
    } catch (error) {
      const failure = error as Error & { stdout?: string; stderr?: string; code?: number; killed?: boolean };
      return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? failure.message, code: typeof failure.code === "number" ? failure.code : 1, killed: failure.killed ?? false };
    }
  },
} as unknown as ExtensionAPI;
const notifications: string[] = [];
const ctx = { cwd: dir, isProjectTrusted: () => false, hasUI: true, ui: { notify: (text: string) => notifications.push(text) } } as unknown as ExtensionContext;
const call = (tool: string, params: Record<string, unknown>, signal?: AbortSignal) => tools.get(tool)!("call", params, signal, undefined, ctx);

before(async () => {
  if (skip) return;
  fs.mkdirSync(agentDir);
  if (herdr) {
    Object.assign(process.env, { PI_ORCHESTRATION_HOST: "herdr", PI_ORCHESTRATION_ENDPOINT: endpoint, PI_CODING_AGENT_DIR: agentDir });
    panelsExtension(pi, GRACE_MS);
    waitExtension(pi);
    return;
  }
  await run("tmux", ["-S", endpoint, "-f", "/dev/null", "new-session", "-d", "-s", "wait", "-x", "120", "-y", "30"]);
  const pane = (await run("tmux", ["-S", endpoint, "display-message", "-p", "-t", "wait", "#{pane_id}"])).stdout.trim();
  Object.assign(process.env, { PI_ORCHESTRATION_HOST: "tmux", PI_ORCHESTRATION_ENDPOINT: endpoint, TMUX_PANE: pane, PI_CODING_AGENT_DIR: agentDir });
  delete process.env.TMUX;
  delete process.env.HERDR_ENV;
  panelsExtension(pi, GRACE_MS);
  waitExtension(pi);
});
after(async () => {
  for (const name of names) await call("panel-close", { name }).catch(() => removeTarget(name));
  if (!skip && !herdr) await run("tmux", ["-S", endpoint, "kill-server"]).catch(() => undefined);
  envKeys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
  fs.rmSync(dir, { recursive: true, force: true });
});

let next = 0;
async function panel(command: string): Promise<string> {
  const name = `wait-test-${process.pid % 10000}-${next++}`;
  names.push(name);
  await call("panel-start", { name, command });
  return name;
}

async function prompted(name: string): Promise<void> {
  const ready = await call("wait", { panel: name, timeoutSeconds: 20 });
  assert.equal(ready.details.outcome, "prompt", ready.content[0].text);
}

test("bash with the integration file reports finished commands, their status, and idle prompts", { skip, timeout: 60_000 }, async () => {
  const name = await panel(`exec bash --rcfile ${SHELL_INTEGRATION.bash} -i`);
  await prompted(name);

  const idle = await call("wait", { panel: name, timeoutSeconds: 20 });
  assert.equal(idle.details.outcome, "prompt", "an idle shell answers immediately");

  const quick = await call("panel-send", { name, text: "echo one; echo two; (exit 4)" });
  assert.deepEqual([quick.details.outcome, quick.details.status], ["finished", 4], quick.content[0].text);
  assert.match(quick.content[0].text, /\nBack at the shell prompt after \d+\.\ds \(exit status 4\)\. Output:\none\ntwo$/, "only the command's own output, without its echoed line or the next prompt");
  const after = await call("wait", { panel: name, timeoutSeconds: 20 });
  assert.deepEqual([after.details.outcome, after.details.status], ["prompt", 4], "a later wait answers immediately");

  const slow = await call("panel-send", { name, text: "sleep 2.5; echo slept" });
  assert.equal(slow.details.outcome, "running");
  assert.match(slow.content[0].text, /Still running after \d+\.\ds; use wait to follow it/);
  const startedAt = Date.now();
  const finished = await call("wait", { panel: name, timeoutSeconds: 20 });
  assert.deepEqual([finished.details.outcome, finished.details.status], ["prompt", 0]);
  assert.ok(Date.now() - startedAt >= 500, "the wait lasted until the command finished");
  assert.match(finished.content[0].text, /slept/);

  await call("panel-send", { name, text: "for i in 1 2 3; do echo step-$i; sleep 0.8; done" });
  const first = await call("wait", { panel: name, match: "^step-2$", timeoutSeconds: 20 });
  assert.deepEqual([first.details.outcome, first.details.line], ["matched", "step-2"]);
  const second = await call("wait", { panel: name, match: "^step-", timeoutSeconds: 20 });
  assert.equal(second.details.line, "step-3", "a later wait continues after the previous match");
  assert.equal((await call("wait", { panel: name, timeoutSeconds: 20 })).details.outcome, "prompt");

  assert.equal((await call("panel-send", { name, text: "sleep 30" })).details.outcome, "running");
  const keys = await call("panel-send", { name, keys: ["ctrl+c"] });
  assert.equal(keys.details.outcome, undefined, "keys return the screen without following a command");
  const interrupted = await call("wait", { panel: name, timeoutSeconds: 20 });
  assert.equal(interrupted.details.outcome, "prompt");
  assert.equal(interrupted.details.status, 130);
});

test("fish reports its prompt without configuration", { skip: skip || (fishMajor < 4 && "requires fish 4+"), timeout: 60_000 }, async () => {
  const name = await panel("exec fish --no-config -i");
  await prompted(name);
  const sent = await call("panel-send", { name, text: "sleep 0.5; false" });
  assert.deepEqual([sent.details.outcome, sent.details.status], ["finished", 1], sent.content[0].text);
  const finished = await call("wait", { panel: name, timeoutSeconds: 20 });
  assert.deepEqual([finished.details.outcome, finished.details.status], ["prompt", 1]);
  const empty = await call("panel-send", { name, text: "" });
  assert.deepEqual([empty.details.outcome, empty.details.status], ["finished", undefined], "an empty line ends at the next prompt");
  assert.match(empty.content[0].text, /Back at the shell prompt after \d+\.\ds\. Output:\n\(no output\)$/);
});

test("a nested marked shell, as over ssh, ends the line that starts it and reports its own commands", { skip: skip || (fishMajor < 4 && "requires fish 4+"), timeout: 60_000 }, async () => {
  const name = await panel("exec fish --no-config -i");
  await prompted(name);
  const login = await call("panel-send", { name, text: `bash --rcfile ${SHELL_INTEGRATION.bash} -i` });
  assert.equal(login.details.outcome, "finished", "the nested shell's first prompt ends the line");
  const inner = await call("panel-send", { name, text: "printf 'α\\nβ\\n'" });
  assert.deepEqual([inner.details.outcome, inner.details.status], ["finished", 0], inner.content[0].text);
  assert.match(inner.content[0].text, /Output:\nα\nβ$/);
  assert.doesNotMatch(inner.content[0].text, /Warning:/);
  const logout = await call("panel-send", { name, text: "exit 3" });
  assert.deepEqual([logout.details.outcome, logout.details.status], ["finished", 3], "the outer shell reports the nested shell's exit");
});

test("text sent into an unmarked program warns once to the user and in every result, until marks return", { skip: skip || (fishMajor < 4 && "requires fish 4+"), timeout: 60_000 }, async () => {
  const name = await panel("exec fish --no-config -i");
  await prompted(name);
  const inner = await call("panel-send", { name, text: "bash --norc --noprofile -i" });
  assert.equal(inner.details.outcome, "running", "an unmarked program never reports its prompt");
  assert.doesNotMatch(inner.content[0].text, /Warning:/, "the marked shell received the command");
  for (const text of ["echo one", "echo two"]) {
    const sent = await call("panel-send", { name, text });
    assert.match(sent.content[0].text, /Warning: Input goes to `bash --norc --noprofile -i`, which shows no OSC 133 prompt marks/);
  }
  assert.equal(notifications.length, 1, "the user is told once per running program");
  const keys = await call("panel-send", { name, keys: ["ctrl+u"] });
  assert.doesNotMatch(keys.content[0].text, /Warning:/, "keys are not commands to wait for");
  await call("panel-send", { name, text: "exit" });
  assert.equal((await call("wait", { panel: name, timeoutSeconds: 20 })).details.outcome, "prompt");
  const back = await call("panel-send", { name, text: "true" });
  assert.equal(back.details.outcome, "finished");
  assert.doesNotMatch(back.content[0].text, /Warning:/);
});

test("command panels end on exit with status and match output printed before the wait", { skip, timeout: 60_000 }, async () => {
  const server = await panel("echo listening on 8080; sleep 30");
  await delay(800);
  const listening = await call("wait", { panel: server, match: "listening on \\d+", timeoutSeconds: 20 });
  assert.equal(listening.details.outcome, "matched", "output since the panel started counts");

  const build = await panel("echo compiling; sleep 1; echo done; exit 3");
  const exited = await call("wait", { panel: build, match: "^FAIL", timeoutSeconds: 20 });
  assert.deepEqual([exited.details.outcome, exited.details.status], ["exited", 3]);
  assert.match(exited.content[0].text, /done/);
  const again = await call("wait", { panel: build, timeoutSeconds: 20 });
  assert.equal(again.details.outcome, "exited", "an exited panel answers immediately");
  await assert.rejects(call("panel-send", { name: build, text: "echo again" }), /The command of panel '[^']+' exited with status 3; its output is no longer captured/);
  await assert.rejects(call("panel-send", { name: build, keys: ["ctrl+c"] }), /exited with status 3/);
  assert.match((await call("panel-read", { name: build })).content[0].text, /done/, "an exited panel's output stays readable");
});

test("shells without prompt marks time out with an explanation instead of guessing", { skip, timeout: 60_000 }, async () => {
  const name = await panel("exec bash --norc --noprofile -i");
  await delay(500);
  await call("panel-send", { name, text: "echo hi" });
  const result = await call("wait", { panel: name, timeoutSeconds: 1 });
  assert.equal(result.details.outcome, "timeout");
  assert.match(result.content[0].text, /Input goes to the panel's command, which has shown no OSC 133 prompt marks/);
  assert.match(result.content[0].text, new RegExp(SHELL_INTEGRATION.bash.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("files match appended lines only, and pids end on exit", { skip, timeout: 30_000 }, async () => {
  const file = path.join(dir, "build.log");
  fs.writeFileSync(file, "FAIL old run\n");
  setTimeout(() => fs.appendFileSync(file, "pass a\nFAIL new run\n"), 300);
  const matched = await call("wait", { file: "build.log", match: "^FAIL", timeoutSeconds: 10 });
  assert.deepEqual([matched.details.outcome, matched.details.line], ["matched", "FAIL new run"]);
  await assert.rejects(call("wait", { file, timeoutSeconds: 1 }), /needs match/);
  await assert.rejects(call("wait", { file: "missing.log", match: "x", timeoutSeconds: 1 }), /does not exist: .*missing\.log\. If a panel or process creates it, wait on that panel .* or pid instead/);
  await assert.rejects(call("wait", { file, match: "(", timeoutSeconds: 1 }), /Invalid match regex/);
  await assert.rejects(call("wait", { file, pid: 1, match: "x", timeoutSeconds: 1 }), /exactly one/);

  const child = spawn("sleep", ["0.5"]);
  const exited = await call("wait", { pid: child.pid, timeoutSeconds: 10 });
  assert.equal(exited.details.outcome, "exited");
  const abort = new AbortController();
  setTimeout(() => abort.abort(), 200);
  await assert.rejects(call("wait", { pid: process.pid, timeoutSeconds: 10 }, abort.signal), /abort/i);
});

test("the capture relay preserves the command's SHELL and exit status", { skip, timeout: 30_000 }, async () => {
  const log = path.join(dir, "relay.log");
  fs.writeFileSync(log, "");
  const argv = capturedArgv(["/bin/sh", "-c", 'printf "shell=%s\\n" "${SHELL-unset}"; exit 5'], log);
  const withShell = await run(argv[0], argv.slice(1), { env: { ...process.env, SHELL: "/usr/bin/fish" } }).catch((error: { code: number }) => error);
  assert.equal((withShell as { code: number }).code, 5);
  assert.match(fs.readFileSync(log, "utf8"), /shell=\/usr\/bin\/fish/);
  const env = { ...process.env };
  delete env.SHELL;
  await run(argv[0], argv.slice(1), { env }).catch(() => undefined);
  assert.match(fs.readFileSync(log, "utf8"), /shell=unset/);
});
