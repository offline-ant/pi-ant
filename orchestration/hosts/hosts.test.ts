import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import test, { after } from "node:test";
import type { ExtensionAPI, ExecResult } from "@earendil-works/pi-coding-agent";
import type { HostTarget } from "../host-types.ts";
import terminalInput from "../extensions/terminal-input.ts";
import { createHerdrHost } from "./herdr.ts";
import { createTmuxHost } from "./tmux.ts";
import { terminalRequest } from "../terminal-input.ts";

function reply(payload: unknown = "", code = 0): ExecResult {
  return { code, stdout: typeof payload === "string" ? payload : JSON.stringify(payload), stderr: "", killed: false };
}
const controls = new Map<string, net.Server>();
const shellDirectories = new Set<string>();
after(async () => {
  for (const directory of shellDirectories) fs.rmSync(directory, { recursive: true, force: true });
  for (const [socketPath, server] of controls) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(path.dirname(socketPath), { recursive: true, force: true });
  }
});
function fake(responses: ExecResult[]): { pi: ExtensionAPI; calls: string[][]; prompts: unknown[] } {
  const calls: string[][] = [];
  const prompts: unknown[] = [];
  const pi = { exec: async (command: string, args: string[]) => {
    calls.push([command, ...args]);
    const response = responses.shift();
    assert.ok(response, `Unexpected command ${command} ${args.join(" ")}`);
    if (response.code === 0 && args.includes("pane") && args.includes("run")) {
      const launch = /^\/bin\/sh '([^']+\/start\.sh)'$/.exec(args.at(-1) ?? "");
      if (launch) {
        shellDirectories.add(path.dirname(launch[1]));
        fs.rmSync(launch[1]);
      }
    }
    if (response.code === 0 && args.includes("agent") && args.includes("start")) {
      const assignment = calls.flat().find((arg) => arg.startsWith("PI_ORCHESTRATION_CONTROL="));
      assert.ok(assignment);
      const socketPath = assignment.slice("PI_ORCHESTRATION_CONTROL=".length);
      const server = net.createServer((client) => {
        client.once("data", (chunk) => { prompts.push(JSON.parse(chunk.toString())); client.end('{"dispatched":true}\n'); });
      });
      await new Promise<void>((resolve) => server.listen(socketPath, resolve));
      controls.set(socketPath, server);
    }
    return response;
  } } as unknown as ExtensionAPI;
  return { pi, calls, prompts };
}
const tmuxParent: HostTarget = { host: "tmux", endpoint: "/tmp/test-tmux", id: "%4", paneId: "%4", name: "parent", kind: "pi" };
const herdrParent: HostTarget = { host: "herdr", endpoint: "/tmp/test-herdr", id: "w1:p4", paneId: "w1:p4", name: "parent", kind: "pi" };

test("tmux shell launch pins endpoint, parent, environment and uses exec", async () => {
  const { pi, calls } = fake([reply("$1\n"), reply("%8\n"), reply("zero\none\ntwo\n\n\n"), reply(), reply(), reply(), reply("1"), reply("1"), reply()]);
  const host = createTmuxHost(pi, tmuxParent.endpoint);
  const target = await host.start({ kind: "shell", name: "server", cwd: "/tmp/a b", placement: "worker", parent: tmuxParent, command: "printf '%s' \"literal\"", env: { CUSTOM: "a b" } });
  assert.equal(target.id, "%8");
  assert.equal(calls[0][0], "tmux");
  assert.deepEqual(calls[0].slice(3), ["display-message", "-p", "-t", "%4", "#{session_id}"]);
  assert.deepEqual(calls[1].slice(1, 9), ["-S", "/tmp/test-tmux", "new-window", "-d", "-t", "$1", "-n", "server"]);
  assert.ok(calls[1].includes("CUSTOM=a b"));
  assert.match(calls[1].at(-1)!, /remain-on-exit on && exec \/bin\/sh -lc /);
  assert.equal(await host.read(target, 2), "one\ntwo");
  await host.send(target, { kind: "text", text: "Enter ctrl+c", enter: true });
  await host.send(target, { kind: "keys", keys: ["ctrl+c", "Escape"] });
  assert.deepEqual(calls[3].slice(3), ["send-keys", "-t", "%8", "-l", "--", "Enter ctrl+c"]);
  assert.deepEqual(calls[5].slice(3), ["send-keys", "-t", "%8", "C-c", "Escape"]);
  assert.equal(await host.state(target), "exited");
  await host.close(target);
  assert.deepEqual(calls.at(-1)?.slice(3), ["kill-pane", "-t", "%8"]);
});

test("tmux fork placement never uses the focused pane", async () => {
  const { pi, calls } = fake([reply("%8\n")]);
  await createTmuxHost(pi, tmuxParent.endpoint).start({ kind: "shell", name: "fork", cwd: "/tmp", placement: "interactive-fork", parent: tmuxParent, command: "sleep 1" });
  assert.deepEqual(calls[0].slice(3, 8), ["split-window", "-d", "-t", "%4", "-P"]);
  await assert.rejects(createTmuxHost(pi, tmuxParent.endpoint).start({ kind: "shell", name: "bad", cwd: "/tmp", placement: "worker", command: "true" }), /explicit parent/);
});

test("tmux missing process is not completion and prompt text is not terminal keys", async () => {
  const { pi } = fake([reply("missing", 1), reply("")]);
  const host = createTmuxHost(pi, tmuxParent.endpoint);
  assert.equal(await host.state(tmuxParent), "missing");
  // tmux display-message succeeds with empty output for a pane that was closed.
  assert.equal(await host.state(tmuxParent), "missing");
  await assert.rejects(host.send({ ...tmuxParent, kind: "shell" }, { kind: "prompt", text: "Enter" }), /owned terminal input endpoint/);
});

test("Herdr pins server and native pane, with named-agent startup and draft-safe prompt", async () => {
  const { pi, calls, prompts } = fake([
    reply({ result: { pane: { workspace_id: "w1" } } }),
    reply({ result: { root_pane: { pane_id: "w1:p8", terminal_id: "term_eight" } } }),
    reply({ result: { agent: { pane_id: "w1:p8", agent: "pi" } } }),
    reply({ result: { pane: { scroll: { viewport_rows: 30 } } } }), reply("preview"), reply(), reply(),
    reply({ result: { pane: {} } }), reply({ result: { agent: { agent: "pi" } } }), reply(),
  ]);
  const host = createHerdrHost(pi, herdrParent.endpoint);
  const target = await host.start({ kind: "pi", name: "worker-one", cwd: "/tmp", sessionFile: "/tmp/session.jsonl", args: ["--model", "test-model"], prompt: "/worker-run /tmp/request.json", placement: "worker", parent: herdrParent });
  assert.equal(target.id, "worker-one");
  assert.equal(target.paneId, "w1:p8");
  assert.equal(calls[0][0], "env");
  assert.equal(calls[0][1], "HERDR_SOCKET_PATH=/tmp/test-herdr");
  assert.deepEqual(calls[0].slice(3), ["pane", "get", "w1:p4"]);
  assert.deepEqual(calls[2].slice(3, -2), ["agent", "start", "worker-one", "--kind", "pi", "--pane", "w1:p8", "--", "--session", "/tmp/session.jsonl", "--model", "test-model"]);
  assert.deepEqual(prompts, [{ kind: "ping" }, { kind: "prompt", text: "/worker-run /tmp/request.json" }]);
  assert.equal(await host.read(target), "preview");
  await host.send(target, { kind: "text", text: "Escape", enter: false });
  await host.send(target, { kind: "keys", keys: ["ctrl+c"] });
  assert.deepEqual(calls[5].slice(3), ["pane", "send-text", "w1:p8", "Escape"]);
  assert.equal(await host.state(target), "running");
  await host.close(target);
  assert.deepEqual(calls.at(-1)?.slice(3), ["pane", "close", "w1:p8"]);
});

test("Herdr fork uses explicit parent rectangle even if another pane is focused", async () => {
  const { pi, calls } = fake([
    reply({ result: { layout: { focused_pane_id: "w1:p9", panes: [
      { pane_id: "w1:p4", rect: { width: 100, height: 20 } },
      { pane_id: "w1:p9", rect: { width: 20, height: 80 } },
    ] } } }),
    reply({ result: { pane: { pane_id: "w1:p8" } } }), reply(),
  ]);
  await createHerdrHost(pi, herdrParent.endpoint).start({ kind: "shell", name: "fork", cwd: "/tmp", command: "sleep 1", placement: "interactive-fork", parent: herdrParent });
  assert.deepEqual(calls[0].slice(3), ["pane", "layout", "--pane", "w1:p4"]);
  assert.deepEqual(calls[1].slice(3, 8), ["pane", "split", "w1:p4", "--direction", "right"]);
});

test("Herdr native readiness retry is separate from result completion", async () => {
  const { pi, calls } = fake([
    reply({ result: { pane: { workspace_id: "w1" } } }), reply({ result: { root_pane: { pane_id: "w1:p8" } } }),
    reply({ error: { code: "agent_pane_busy" } }, 1), reply(),
  ]);
  await createHerdrHost(pi, herdrParent.endpoint).start({ kind: "pi", name: "worker", cwd: "/tmp", sessionFile: "/tmp/session", args: [], placement: "worker", parent: herdrParent });
  assert.deepEqual(calls[2], calls[3]);
});

test("Herdr surviving shell does not prove its Pi is alive; transport failures propagate", async () => {
  const { pi } = fake([
    reply({ result: { pane: {} } }), reply({ error: { code: "agent_not_found" } }, 1),
    reply({ error: { code: "pane_not_found" } }, 1), reply({ error: { code: "protocol_mismatch" } }, 1),
    reply({ result: { pane: {} } }), reply({ result: { process_info: { foreground_processes: [] } } }),
  ]);
  const host = createHerdrHost(pi, herdrParent.endpoint);
  assert.equal(await host.state(herdrParent), "exited");
  assert.equal(await host.state(herdrParent), "missing");
  await assert.rejects(host.state(herdrParent), /protocol_mismatch/);
  assert.equal(await host.state({ ...herdrParent, kind: "shell" }), "exited");
});

test("Herdr failed startup closes only the newly created target", async () => {
  const { pi, calls } = fake([
    reply({ result: { pane: { workspace_id: "w1" } } }), reply({ result: { root_pane: { pane_id: "w1:p8" } } }),
    reply("could not start", 1), reply(),
  ]);
  await assert.rejects(createHerdrHost(pi, herdrParent.endpoint).start({ kind: "pi", name: "worker", cwd: "/tmp", sessionFile: "/tmp/session", args: [], placement: "worker", parent: herdrParent }), /could not start/);
  assert.deepEqual(calls.at(-1)?.slice(3), ["pane", "close", "w1:p8"]);
});

test("cancellation during native creation closes the target once its identity is known", async () => {
  for (const kind of ["tmux", "herdr"] as const) {
    const controller = new AbortController();
    const responses = kind === "tmux"
      ? [reply("$1"), reply("%8"), reply("0"), reply()]
      : [reply({ result: { pane: { workspace_id: "w1" } } }), reply({ result: { root_pane: { pane_id: "w1:p8" } } }), reply()];
    const { pi, calls } = fake(responses);
    const original = pi.exec;
    pi.exec = async (command, args, options) => {
      const response = await original(command, args, options);
      if (args.includes("new-window") || args.includes("create")) controller.abort();
      return response;
    };
    const host = kind === "tmux" ? createTmuxHost(pi, tmuxParent.endpoint) : createHerdrHost(pi, herdrParent.endpoint);
    await assert.rejects(host.start({ kind: "pi", name: "cancelled", cwd: "/tmp", sessionFile: "/tmp/session", args: [], placement: "worker", parent: kind === "tmux" ? tmuxParent : herdrParent }, controller.signal));
    assert.ok(calls.at(-1)?.includes(kind === "tmux" ? "kill-pane" : "close"));
    const assignment = calls.flat().find((arg) => arg.startsWith("PI_ORCHESTRATION_CONTROL="));
    assert.ok(assignment);
    assert.equal(fs.existsSync(path.dirname(assignment.slice("PI_ORCHESTRATION_CONTROL=".length))), false);
  }
});

test("terminal Pi input dispatch never reads, clears, or appends to the human draft", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-input-test-"));
  const socketPath = path.join(dir, "input.sock");
  const previous = process.env.PI_ORCHESTRATION_CONTROL;
  process.env.PI_ORCHESTRATION_CONTROL = socketPath;
  const hooks = new Map<string, () => Promise<void>>();
  const sent: unknown[][] = [];
  const pi = {
    on: (name: string, handler: () => Promise<void>) => hooks.set(name, handler),
    sendUserMessage: (...args: unknown[]) => sent.push(args),
  } as unknown as ExtensionAPI;
  try {
    terminalInput(pi);
    await hooks.get("session_start")!();
    assert.equal(fs.statSync(socketPath).mode & 0o777, 0o600);
    await terminalRequest(socketPath, { kind: "ping" });
    await terminalRequest(socketPath, { kind: "prompt", text: '/worker-run "a\nb"\u2028literal' });
    assert.deepEqual(sent, [['/worker-run "a\nb"\u2028literal', { deliverAs: "followUp", expandPromptTemplates: true }]]);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(async () => terminalRequest(socketPath, { kind: "ping" }, controller.signal));
    await hooks.get("session_shutdown")!();
    assert.equal(fs.existsSync(socketPath), false);
  } finally {
    if (previous === undefined) delete process.env.PI_ORCHESTRATION_CONTROL;
    else process.env.PI_ORCHESTRATION_CONTROL = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
