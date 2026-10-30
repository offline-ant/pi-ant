import assert from "node:assert/strict";
import test from "node:test";
import type { EmacsExec } from "./hosts/emacs.ts";
import { emacsDaemon, emacsLauncherEnvironment, prepareEmacsSwitch } from "./switch-emacs.ts";
import type { SwitchSource } from "./switch-destinations.ts";

const source: SwitchSource = {
  sessionFile: "/tmp/fixture/session.jsonl", cwd: "/tmp/fixture",
  args: ["--provider", "fixture", "--model", "one", "--thinking", "high"],
  env: { PI_CODING_AGENT_DIR: "/tmp/agent", PI_ORCHESTRATION_TARGET: "", PI_NESTED: "", HERDR_SOCKET_PATH: "/tmp/herdr.sock" },
};

/** Decodes companion operations from emacsclient arguments and answers them. */
function companion(answer: (data: Record<string, unknown>) => Record<string, unknown>) {
  const operations: Record<string, unknown>[] = [];
  const exec: EmacsExec = async (command, args) => {
    assert.equal(command, "emacsclient");
    assert.deepEqual(args.slice(0, 3), ["--socket-name", "/tmp/emacs/pi", "--eval"]);
    const encoded = /pi-orchestration-dispatch "([^"]+)"/.exec(args[3]!)![1]!;
    const data = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as Record<string, unknown>;
    operations.push(data);
    const reply = Buffer.from(JSON.stringify(answer(data)), "utf8").toString("base64");
    return { code: 0, stdout: `${JSON.stringify(reply)}\n`, stderr: "", killed: false };
  };
  return { exec, operations };
}

test("Emacs switch opens an ordinary root session and waits for confirmed readiness", async () => {
  let polls = 0;
  const { exec, operations } = companion((data) => {
    if (data.operation === "switch") return { buffer: "*pilish-chat:/tmp/fixture/*", refreshed: false };
    return { state: "running", ready: ++polls >= 3, failure: null };
  });
  const location = await (await prepareEmacsSwitch(source, "/tmp/emacs/pi", exec)).start();
  assert.equal(location, "Emacs /tmp/emacs/pi, buffer *pilish-chat:/tmp/fixture/*");
  const opened = operations[0]!;
  assert.equal(opened.operation, "switch");
  assert.equal(opened.sessionFile, source.sessionFile);
  assert.equal(opened.cwd, source.cwd);
  assert.deepEqual(opened.args, source.args);
  // The companion's session hook supplies host, endpoint and target identity.
  assert.deepEqual(opened.env, { PI_CODING_AGENT_DIR: "/tmp/agent", PI_NESTED: "", HERDR_SOCKET_PATH: "/tmp/herdr.sock" });
  assert.deepEqual(operations.slice(1).map((data) => [data.operation, data.id, data.close]),
    Array(3).fill(["switch-state", opened.id, undefined]));
});

test("readiness polling outlasts an Emacs that does not answer", async () => {
  let polls = 0;
  const { exec } = companion((data) => data.operation === "switch" ? { buffer: "chat", refreshed: false } : { state: "running", ready: true });
  const stalling: EmacsExec = async (command, args, options) => args[3]!.includes("dispatch") && ++polls === 2
    ? { code: 0, stdout: "", stderr: "", killed: true } : exec(command, args, options);
  assert.match(await (await prepareEmacsSwitch(source, "/tmp/emacs/pi", stalling)).start(), /buffer chat/);
  assert.equal(polls, 3);
});

test("a failed new session is closed, while a failed reload of an open view is left alone", async () => {
  for (const refreshed of [false, true]) {
    const { exec, operations } = companion((data) => data.operation === "switch"
      ? { buffer: "chat", refreshed } : { state: "running", ready: false, failure: "Pi opened a different session file" });
    await assert.rejects((await prepareEmacsSwitch(source, "/tmp/emacs/pi", exec)).start(),
      /Emacs switch failed \(Pi opened a different session file\)\. No source view was closed/);
    // The companion closes only sessions it started; the request always settles.
    assert.deepEqual(operations.at(-1), { operation: "switch-state", id: operations[0]!.id, close: true });
  }
  const { exec, operations } = companion(() => ({ error: "The Emacs view of this session is busy or has queued input; finish it first" }));
  await assert.rejects((await prepareEmacsSwitch(source, "/tmp/emacs/pi", exec)).start(), /busy or has queued input.*No source view was closed/s);
  assert.equal(operations.length, 1, "nothing to clean up when opening was refused");
});

test("pi-emacs resolves and starts the daemon without leaking this frontend's identity", async () => {
  const calls: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
  const environment = { HOME: "/home/x", PATH: "/bin", PI_EMACS_SERVER: "disposable", HERDR_ENV: "1", HERDR_PANE_ID: "p1",
    PI_ORCHESTRATION_HOST: "herdr", PI_ORCHESTRATION_ENDPOINT: "/tmp/herdr.sock", PI_ORCHESTRATION_CONTROL: "/tmp/c", TMUX: "x" };
  const socket = await emacsDaemon(environment, async (command, args, options) => {
    calls.push({ command, args, env: options.env });
    return { code: 0, stdout: "\x1b[1 q\"/tmp/emacs1002/disposable\"\n", stderr: "Starting Emacs daemon.\n", killed: false };
  });
  assert.equal(socket, "/tmp/emacs1002/disposable");
  assert.deepEqual(calls.map(({ command, args }) => [command, args]), [["pi-emacs", ["-e", "(expand-file-name server-name server-socket-dir)"]]]);
  assert.deepEqual(calls[0]!.env, { HOME: "/home/x", PATH: "/bin", PI_EMACS_SERVER: "disposable" });
  assert.deepEqual(emacsLauncherEnvironment({ PI_NESTED: "1", TMUX_PANE: "%1", KEEP: "y" }), { KEEP: "y" });
  await assert.rejects(emacsDaemon(environment, async () => ({ code: 1, stdout: "", stderr: "emacsclient: can't find socket\n", killed: false })),
    /pi-emacs did not start or reach its Emacs daemon: emacsclient: can't find socket/);
  await assert.rejects(emacsDaemon(environment, async () => { throw Object.assign(new Error("spawn pi-emacs ENOENT"), { code: "ENOENT" }); }),
    /Cannot run pi-emacs/);
});

test("an explicitly selected Emacs host is used only when it already runs", async () => {
  const environment = { PI_ORCHESTRATION_HOST: "emacs", PI_ORCHESTRATION_ENDPOINT: "/tmp/emacs/other" };
  const seen: string[][] = [];
  assert.equal(await emacsDaemon(environment, async (command, args) => {
    seen.push([command, ...args]);
    return { code: 0, stdout: "t\n", stderr: "", killed: false };
  }), "/tmp/emacs/other");
  assert.deepEqual(seen, [["emacsclient", "--socket-name", "/tmp/emacs/other", "--eval", "t"]]);
  for (const unreachable of [{ code: 1, killed: false }, { code: 0, killed: true }]) {
    await assert.rejects(emacsDaemon(environment, async () => ({ ...unreachable, stdout: "", stderr: "" })),
      /Cannot reach the Emacs server \/tmp\/emacs\/other; \/switch starts only pi-emacs daemons/);
  }
});
