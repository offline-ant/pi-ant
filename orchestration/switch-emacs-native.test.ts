import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { TOOL_SELECTION_ENTRY } from "../extensions/tool-selection.ts";
import { flushSessionFile } from "./context.ts";
import { parseWebEndpoint } from "./hosts/web.ts";

const exec = promisify(execFile);
const enabled = process.env.PI_SWITCH_EMACS_NATIVE === "1";
interface Trace {
  event: string; pid: number; workspace?: string; file: string; sessionId: string; mode: string; host?: string; target?: string; endpoint?: string;
  cwd: string; model: string; provider: string; thinking: string; tools: string[]; branch: string[];
}
interface LiveSession { id: string; sessionFile: string }
async function until(check: () => boolean | Promise<boolean>, message: string, timeout = 60_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!await check()) {
    assert.ok(Date.now() < deadline, `Timed out: ${message}`);
    await delay(50);
  }
}
function stopped(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return true; throw error; }
}
const quote = (text: string): string => `'${text.replaceAll("'", `'"'"'`)}'`;
const lisp = (text: string): string => JSON.stringify(text);
function lines(file: string): string[] {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean) : [];
}
async function freePort(): Promise<number> {
  const listener = net.createServer();
  await new Promise<void>((resolve) => listener.listen(0, "0.0.0.0", resolve));
  const port = (listener.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  return port;
}

test("native /switch: plain RPC source → Emacs (pi-deck space) → Tau → reloads the open Emacs view, without inference", {
  skip: !enabled, timeout: 300_000,
}, async (t) => {
  const installedTau = (process.env.PATH || "").split(path.delimiter).map((entry) => path.join(entry, "pi-tau-web-server")).find((file) => {
    try { fs.accessSync(file, fs.constants.X_OK); return true; } catch { return false; }
  });
  assert.ok(installedTau, "Install the local fork's pi-tau-web-server on PATH before native verification");
  const workspace = fileURLToPath(new URL("../../", import.meta.url));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-switch-emacs-"));
  const agentDir = path.join(directory, "agent");
  const sessionDir = path.join(agentDir, "sessions", "fixture");
  const bin = path.join(directory, "test-bin");
  const socketDir = path.join(directory, "emacs");
  const socket = path.join(socketDir, "server");
  const daemons = path.join(directory, "emacs-daemons.txt");
  const launches = path.join(directory, "tau-launches.txt");
  const opened = path.join(directory, "opened-urls.txt");
  const publication = path.join(agentDir, "tau", "server.json");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(bin);
  fs.mkdirSync(socketDir, { mode: 0o700 });
  // A disposable daemon in place of the user's pi-emacs: -Q, private
  // init directory, real Pilish, companion and pi-deck with private state.
  fs.writeFileSync(path.join(directory, "deck.el"), `${[
    `(setq pi-deck-state-file ${lisp(path.join(directory, "deck", "state.eld"))}`,
    `      pi-deck-preferences-file ${lisp(path.join(directory, "deck", "preferences.eld"))})`,
    `(add-to-list 'load-path ${lisp(path.join(workspace, "pi-deck"))})`,
    // Grammars stay in the real configuration; never install or prompt here.
    `(setq treesit-extra-load-path (list ${lisp(path.join(os.homedir(), ".emacs.d", "tree-sitter"))}))`,
    "(require 'pi-deck)", "(pi-deck-mode 1)",
  ].join("\n")}\n`);
  fs.writeFileSync(path.join(bin, "pi-emacs"), [
    "#!/bin/sh", "set -eu",
    `if ! emacsclient -s ${quote(socket)} -e t >/dev/null 2>&1; then`,
    `  PI_EMACS_ELPA=${quote(path.join(os.homedir(), ".emacs.d", "elpa"))} PI_EMACS_GHOSTEL_MODULE=${quote(path.join(os.homedir(), ".emacs.d", "var", "ghostel/"))} \\`,
    `    emacs -Q --init-directory=${quote(path.join(directory, "emacs.d"))} --daemon=${quote(socket)} \\`,
    `    -l ${quote(fileURLToPath(new URL("./test/emacs-host.el", import.meta.url)))} -l ${quote(path.join(directory, "deck.el"))} >&2`,
    `  emacsclient -s ${quote(socket)} -e '(emacs-pid)' >> ${quote(daemons)}`,
    "fi",
    `[ "\${1:-}" = -e ] && shift`,
    `exec emacsclient -s ${quote(socket)} -e "$@"`, "",
  ].join("\n"), { mode: 0o700 });
  fs.writeFileSync(path.join(bin, "pi-tau-web-server"), [
    "#!/bin/sh", `printf '%s\\n' "$$" >> ${quote(launches)}`, `exec ${quote(installedTau)} "$@"`, "",
  ].join("\n"), { mode: 0o700 });
  for (const opener of ["xdg-open", "open"]) {
    fs.writeFileSync(path.join(bin, opener), `#!/bin/sh\nprintf '%s\\n' "$1" >> ${quote(opened)}\n`, { mode: 0o700 });
  }
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
    defaultProvider: "switch-native-fixture", defaultModel: "one", defaultThinkingLevel: "high",
    compaction: { enabled: false }, retry: { enabled: false },
    extensions: [
      fileURLToPath(new URL("../extensions/tools.ts", import.meta.url)),
      fileURLToPath(new URL("./extensions/switch.ts", import.meta.url)),
      fileURLToPath(new URL("./test/switch-native-fixture.ts", import.meta.url)),
    ],
  }));
  const seed = SessionManager.create(directory, sessionDir);
  seed.appendModelChange("switch-native-fixture", "one");
  seed.appendThinkingLevelChange("high");
  seed.appendCustomEntry(TOOL_SELECTION_ENTRY, { enabledTools: ["read"] });
  const selected = seed.appendCustomEntry("switch-smoke:selected", {});
  const abandoned = seed.appendCustomEntry("switch-smoke:abandoned", {});
  const sessionFile = seed.getSessionFile()!;
  flushSessionFile(seed, sessionFile);
  const trace = (): Trace[] => lines(path.join(directory, "switch-trace.jsonl")).map((line) => JSON.parse(line) as Trace);
  const after = async (index: number, match: (entry: Trace) => boolean, message: string, timeout?: number): Promise<Trace> => {
    await until(() => trace().slice(index).some(match), message, timeout);
    return trace().slice(index).findLast(match)!;
  };
  const emacs = async (expression: string): Promise<string> =>
    (await exec("emacsclient", ["-s", socket, "--eval", expression], { timeout: 30_000 })).stdout.trim();

  // A plain RPC source outside every terminal host and Emacs.
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH || ""}`,
    PI_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_SESSION_DIR: path.dirname(sessionDir),
    TAU_HOST: "", TAU_HTTP_PORT: String(await freePort()), TAU_PORT: String(await freePort()),
    TAU_USER: "switch-test", TAU_PASS: "switch-test-secret" };
  for (const key of ["PI_NESTED", "PI_ORCHESTRATION_HOST", "PI_ORCHESTRATION_ENDPOINT", "PI_ORCHESTRATION_TARGET", "PI_ORCHESTRATION_CONTROL",
    "PI_EMACS_SERVER", "HERDR_ENV", "HERDR_SOCKET_PATH", "HERDR_WORKSPACE_ID", "HERDR_TAB_ID", "HERDR_PANE_ID", "TMUX", "TMUX_PANE", "PI_REMOTE"]) delete env[key];
  const source = spawn("pi", ["--mode", "rpc", "--session", sessionFile, "--provider", "switch-native-fixture", "--model", "one",
    "--thinking", "high", "--no-skills", "--no-context-files", "--no-prompt-templates"], { cwd: directory, env, stdio: ["pipe", "pipe", "inherit"] });
  const notices: string[] = [];
  createInterface({ input: source.stdout! }).on("line", (line) => {
    try {
      const message = JSON.parse(line) as { type?: string; method?: string; message?: string };
      if (message.type === "extension_ui_request" && message.method === "notify" && message.message) notices.push(message.message);
    } catch { /* not a protocol line */ }
  });
  const prompt = (message: string): void => { source.stdin!.write(`${JSON.stringify({ type: "prompt", message })}\n`); };
  const workspaces = new Set<string>();
  let base = "";
  let headers: Record<string, string> = {};
  const tau = async (route: string, body?: unknown): Promise<Record<string, unknown>> => {
    const response = await fetch(base + route, {
      method: body === undefined ? "GET" : "POST", headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(120_000),
    });
    assert.ok(response.ok, `${route}: HTTP ${response.status}`);
    return await response.json() as Record<string, unknown>;
  };
  try {
    const first = await after(0, (entry) => entry.event === "start" && entry.pid === source.pid, "plain RPC source startup");
    assert.equal(first.mode, "rpc"); assert.equal(first.host, undefined);
    prompt(`/switch-smoke-branch ${selected}`);
    await after(0, (entry) => entry.event === "branched", "non-tip branch navigation");

    // Source → Emacs: the launcher autostarts the disposable daemon.
    let mark = trace().length;
    prompt("/switch emacs");
    const inEmacs = await after(mark, (entry) => entry.event === "start" && entry.host === "emacs", "Emacs Pilish startup", 120_000);
    assert.equal(inEmacs.endpoint, socket, "the companion marks the daemon's own socket");
    assert.match(inEmacs.target ?? "", /^\*pilish-chat:/, "an ordinary root session: its target is its chat buffer");
    await until(() => notices.some((notice) => notice.includes(`Session open in Emacs ${socket}, buffer ${inEmacs.target}`)), "source receipt");
    await after(mark, (entry) => entry.event === "start" && entry.pid === source.pid, "source reloads its same session");
    assert.ok(!stopped(source.pid!), "the source stays open");
    assert.equal(lines(daemons).length, 1, "exactly one daemon was started");
    // pi-deck put it in a new space for its directory, for the next frame.
    assert.equal(await emacs(`(pi-deck-agent-assigned-space (pi-deck-agent (get-buffer ${lisp(inEmacs.target!)})))`),
      lisp(path.basename(directory)));
    assert.equal(await emacs("(buffer-name pi-deck--pending-reveal)"), lisp(inEmacs.target!));
    const chat = inEmacs.target!;

    // Emacs → Tau from the Pilish session, which stays open.
    mark = trace().length;
    await emacs(`(pilish-submit-prompt (get-buffer ${lisp(chat)}) "/switch tau" #'ignore)`);
    await until(() => fs.existsSync(publication), "automatic Tau publication", 120_000);
    ({ base, headers } = parseWebEndpoint((JSON.parse(fs.readFileSync(publication, "utf8")) as { endpoint: string }).endpoint));
    await until(async () => ((await tau("/api/live-sessions")).sessions as LiveSession[]).some((entry) => entry.sessionFile === sessionFile),
      "Tau destination readiness", 120_000);
    await after(mark, (entry) => entry.event === "start" && entry.pid === inEmacs.pid, "Emacs source reloads its same session");
    await until(() => lines(opened).length === 1, "browser opener after confirmed handoff");
    const live = ((await tau("/api/live-sessions")).sessions as LiveSession[]).find((entry) => entry.sessionFile === sessionFile)!;
    mark = trace().length;
    await tau("/api/rpc", { type: "prompt", sessionId: live.id, message: "/switch-smoke-state" });
    const inTau = await after(mark, (entry) => entry.event === "state" && entry.host === "web", "Tau state report");
    await tau("/api/rpc", { type: "prompt", sessionId: live.id, message: "/switch-smoke-mark written-in-tau" });
    const written = (await after(mark, (entry) => entry.event === "marked" && entry.host === "web", "Tau writes history")).branch.at(-1)!;

    // Tau → Emacs again: the idle Emacs view of this file reloads in place.
    mark = trace().length;
    await tau("/api/rpc", { type: "prompt", sessionId: live.id, message: "/switch emacs" });
    const reloaded = await after(mark, (entry) => entry.event === "start" && entry.host === "emacs", "Emacs view reload", 120_000);
    assert.notEqual(reloaded.pid, inEmacs.pid, "reload restarts the view's Pi process");
    assert.equal(reloaded.target, chat, "the same Pilish view, not a duplicate");
    assert.equal(await emacs(`(length (seq-filter (lambda (b) (eq (buffer-local-value 'major-mode b) 'pilish-chat-mode)) (buffer-list)))`), "1");
    assert.ok(reloaded.branch.includes(written), "the Emacs view shows history written in Tau");
    assert.equal(lines(daemons).length, 1, "the running daemon is reused");
    mark = trace().length;
    await emacs(`(pilish-submit-prompt (get-buffer ${lisp(chat)}) "/switch-smoke-state" #'ignore)`);
    const final = await after(mark, (entry) => entry.event === "state" && entry.host === "emacs", "final Emacs state report");
    for (const state of [inEmacs, inTau, reloaded, final]) {
      assert.equal(state.file, sessionFile); assert.equal(state.sessionId, seed.getSessionId());
      assert.equal(state.cwd, directory); assert.equal(state.provider, "switch-native-fixture");
      assert.equal(state.model, "one"); assert.equal(state.thinking, "high");
      assert.deepEqual(state.tools, ["read"]);
      assert.ok(state.branch.includes(selected)); assert.ok(!state.branch.includes(abandoned));
    }
    // Inside Herdr, the Pilish view also leaves for a fresh Herdr workspace.
    if (process.env.HERDR_ENV === "1") {
      mark = trace().length;
      await emacs(`(pilish-submit-prompt (get-buffer ${lisp(chat)}) "/switch herdr" #'ignore)`);
      const inHerdr = await after(mark, (entry) => entry.event === "start" && entry.host === "herdr", "Herdr startup from Pilish", 120_000);
      if (inHerdr.workspace) workspaces.add(inHerdr.workspace);
      assert.equal(inHerdr.file, sessionFile); assert.equal(inHerdr.model, "one"); assert.deepEqual(inHerdr.tools, ["read"]);
      assert.ok(inHerdr.branch.includes(written));
      await after(mark, (entry) => entry.event === "start" && entry.pid === final.pid, "Emacs view reloads its same session");
    } else t.diagnostic("Not inside Herdr; skipped the Pilish → Herdr leg");
    assert.ok(!trace().some((entry) => entry.event === "unexpected-inference"));
    t.diagnostic("Passed plain→Emacs→Tau→Emacs: same file/id/branch/tools/model/cwd, autostarted and reused daemon, pi-deck space, reloaded open view, every source stays open, no inference.");
  } catch (error) {
    t.diagnostic(`Fixture trace: ${JSON.stringify(trace())}; notices: ${JSON.stringify(notices)}`);
    throw error;
  } finally {
    // Only Herdr workspaces created for this test's own session.
    for (const workspace of workspaces) {
      await exec(process.env.HERDR_BIN_PATH || "herdr", ["workspace", "close", workspace], { timeout: 30_000 }).catch(() => {});
    }
    source.kill("SIGTERM");
    for (const line of lines(daemons)) {
      const pid = Number(line);
      assert.ok(Number.isSafeInteger(pid) && pid > 1, "invalid test-owned Emacs PID");
      await exec("emacsclient", ["-s", socket, "--eval", "(kill-emacs)"], { timeout: 10_000 }).catch(() => {});
      await until(() => stopped(pid), "test-owned Emacs daemon exits", 15_000).catch(() => process.kill(pid, "SIGKILL"));
    }
    for (const line of lines(launches)) {
      const pid = Number(line);
      assert.ok(Number.isSafeInteger(pid) && pid > 1, "invalid test-owned Tau PID");
      if (!stopped(pid)) process.kill(pid, "SIGTERM");
      await until(() => stopped(pid), "test-owned Tau server exits", 15_000);
    }
    await until(() => source.exitCode !== null || source.signalCode !== null, "source Pi exits", 15_000);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
