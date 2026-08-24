import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  closeHerdrAgent,
  getAgent,
  modelCliArgs,
  paneWaitOutputArgs,
  promptHerdrAgent,
  startHerdrPiAgent,
  validateHerdrAgentName,
  workerAgentName,
  type HerdrCommandResult,
} from "./herdr-helpers.ts";

interface ExecCall {
  command: string;
  args: string[];
}

function result(code: number, payload: unknown): HerdrCommandResult {
  return {
    code,
    stdout: typeof payload === "string" ? payload : JSON.stringify(payload),
    stderr: code === 0 ? "" : String(payload),
    killed: false,
  };
}

function fakePi(responses: HerdrCommandResult[], calls: ExecCall[]): ExtensionAPI {
  return {
    exec: async (command: string, args: string[]) => {
      calls.push({ command, args });
      const response = responses.shift();
      if (!response) throw new Error("Unexpected exec call");
      return response;
    },
  } as unknown as ExtensionAPI;
}

async function withHerdrEnv(run: () => Promise<void>): Promise<void> {
  const previousEnv = process.env.HERDR_ENV;
  const previousSocket = process.env.HERDR_SOCKET_PATH;
  const previousBin = process.env.HERDR_BIN_PATH;
  const previousNested = process.env.PI_NESTED;
  process.env.HERDR_ENV = "1";
  process.env.HERDR_SOCKET_PATH = "/tmp/herdr-test.sock";
  delete process.env.HERDR_BIN_PATH;
  process.env.PI_NESTED = "2";
  try {
    await run();
  } finally {
    if (previousEnv === undefined) delete process.env.HERDR_ENV;
    else process.env.HERDR_ENV = previousEnv;
    if (previousSocket === undefined) delete process.env.HERDR_SOCKET_PATH;
    else process.env.HERDR_SOCKET_PATH = previousSocket;
    if (previousBin === undefined) delete process.env.HERDR_BIN_PATH;
    else process.env.HERDR_BIN_PATH = previousBin;
    if (previousNested === undefined) delete process.env.PI_NESTED;
    else process.env.PI_NESTED = previousNested;
  }
}

test("child Pi arguments pin the parent model and thinking level", () => {
  assert.deepEqual(
    modelCliArgs({ provider: "openai-codex", id: "gpt-5.6-sol" }, "high"),
    ["--provider", "openai-codex", "--model", "gpt-5.6-sol", "--thinking", "high"],
  );
});

test("child Pi startup fails instead of selecting an unrelated model", () => {
  assert.throws(
    () => modelCliArgs(undefined, "high"),
    /Current session has no selected model/,
  );
});

test("worker agent names satisfy Herdr's strict contract", () => {
  assert.equal(workerAgentName("delegate", "m123-abcd"), "delegate-m123-abcd");
  assert.equal(validateHerdrAgentName("fork_1"), "fork_1");
  assert.throws(() => validateHerdrAgentName("Uppercase"), /lowercase letter/);
  assert.throws(() => validateHerdrAgentName("a".repeat(33)), /at most 32/);
  assert.throws(() => workerAgentName("history", "m123-invalid.id"), /contain only/);
});

test("Pi agent startup creates an environment tab and uses agent start readiness", async () => {
  await withHerdrEnv(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-helper-test-"));
    const sessionFile = path.join(dir, "session.jsonl");
    fs.writeFileSync(sessionFile, "{}\n");
    const calls: ExecCall[] = [];
    const pi = fakePi([
      result(0, { result: { root_pane: { pane_id: "w1:p1", terminal_id: "term-1" }, tab: { tab_id: "w1:t1" } } }),
      result(0, { result: { agent: { pane_id: "w1:p1", terminal_id: "term-1", agent: "pi" } } }),
    ], calls);

    try {
      const started = await startHerdrPiAgent(pi, {
        name: "delegate-m123-abcd",
        cwd: "/tmp/project",
        sessionFile,
        piArgs: ["--provider", "test", "--model", "model"],
        env: { PI_HERDR_FORK: "true" },
      });
      assert.deepEqual(started, {
        agentName: "delegate-m123-abcd",
        paneId: "w1:p1",
        terminalId: "term-1",
        tabId: "w1:t1",
      });
      assert.deepEqual(calls, [
        {
          command: "herdr",
          args: [
            "tab", "create", "--cwd", "/tmp/project", "--label", "delegate-m123-abcd", "--no-focus",
            "--env", "PI_HERDR_FORK=true", "--env", "PI_NESTED=2",
          ],
        },
        {
          command: "herdr",
          args: [
            "agent", "start", "delegate-m123-abcd", "--kind", "pi", "--pane", "w1:p1", "--",
            "--session", sessionFile, "--provider", "test", "--model", "model",
          ],
        },
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("concurrent child requests serialize startup until the prior agent is ready", async () => {
  await withHerdrEnv(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-helper-test-"));
    const firstSession = path.join(dir, "first.jsonl");
    const secondSession = path.join(dir, "second.jsonl");
    fs.writeFileSync(firstSession, "{}\n");
    fs.writeFileSync(secondSession, "{}\n");
    const calls: ExecCall[] = [];
    let tabCount = 0;
    let startCount = 0;
    let releaseFirstStart!: () => void;
    const firstStartReady = new Promise<void>((resolve) => {
      releaseFirstStart = resolve;
    });
    const pi = {
      exec: async (command: string, args: string[]) => {
        calls.push({ command, args });
        if (args[0] === "tab") {
          tabCount++;
          return result(0, {
            result: {
              root_pane: { pane_id: `w1:p${tabCount}` },
              tab: { tab_id: `w1:t${tabCount}` },
            },
          });
        }
        startCount++;
        if (startCount === 1) await firstStartReady;
        return result(0, { result: { agent: { pane_id: `w1:p${startCount}`, agent: "pi" } } });
      },
    } as unknown as ExtensionAPI;

    try {
      const first = startHerdrPiAgent(pi, {
        name: "delegate-m123-first",
        cwd: dir,
        sessionFile: firstSession,
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      const second = startHerdrPiAgent(pi, {
        name: "delegate-m123-second",
        cwd: dir,
        sessionFile: secondSession,
      });
      await new Promise<void>((resolve) => setImmediate(resolve));

      assert.deepEqual(calls.map((call) => call.args.slice(0, 3)), [
        ["tab", "create", "--cwd"],
        ["agent", "start", "delegate-m123-first"],
      ]);

      releaseFirstStart();
      await Promise.all([first, second]);
      assert.deepEqual(calls.map((call) => call.args.slice(0, 3)), [
        ["tab", "create", "--cwd"],
        ["agent", "start", "delegate-m123-first"],
        ["tab", "create", "--cwd"],
        ["agent", "start", "delegate-m123-second"],
      ]);
    } finally {
      releaseFirstStart();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("agent startup retries while a new tab shell is not yet available", async () => {
  await withHerdrEnv(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-helper-test-"));
    const sessionFile = path.join(dir, "session.jsonl");
    fs.writeFileSync(sessionFile, "{}\n");
    const calls: ExecCall[] = [];
    const pi = fakePi([
      result(0, { result: { root_pane: { pane_id: "w1:p2" }, tab: { tab_id: "w1:t2" } } }),
      result(1, { error: { code: "agent_pane_busy", message: "shell is starting" } }),
      result(0, { result: { agent: { pane_id: "w1:p2", agent: "pi" } } }),
    ], calls);

    try {
      const started = await startHerdrPiAgent(pi, { name: "history-m123-abcd", cwd: "/tmp/project", sessionFile });
      assert.equal(started.paneId, "w1:p2");
      assert.equal(calls.length, 3);
      assert.deepEqual(calls[2]?.args, calls[1]?.args);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("failed agent startup closes its newly created pane", async () => {
  await withHerdrEnv(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-helper-test-"));
    const sessionFile = path.join(dir, "session.jsonl");
    fs.writeFileSync(sessionFile, "{}\n");
    const calls: ExecCall[] = [];
    const pi = fakePi([
      result(0, { result: { root_pane: { pane_id: "w1:p2" }, tab: { tab_id: "w1:t2" } } }),
      result(1, "agent failed"),
      result(0, { result: {} }),
    ], calls);

    try {
      await assert.rejects(
        startHerdrPiAgent(pi, { name: "history-m123-abcd", cwd: "/tmp/project", sessionFile }),
        /agent failed/,
      );
      assert.deepEqual(calls.at(-1)?.args, ["pane", "close", "w1:p2"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("pane output waits use Herdr 0.7.5 literal and regex commands", () => {
  assert.deepEqual(
    paneWaitOutputArgs("w1:p4", { match: "ready", timeoutMs: 1500.1 }),
    ["pane", "wait-output", "w1:p4", "--match", "ready", "--source", "recent", "--timeout", "1501"],
  );
  assert.deepEqual(
    paneWaitOutputArgs("w1:p4", { match: "ready.*", regex: true }),
    ["pane", "wait-output", "w1:p4", "--regex", "ready.*", "--source", "recent"],
  );
});

test("agent prompting and lookup use named agent commands", async () => {
  await withHerdrEnv(async () => {
    const calls: ExecCall[] = [];
    const pi = fakePi([
      result(0, { result: {} }),
      result(0, { result: { agent: { pane_id: "w1:p3", agent: "pi" } } }),
    ], calls);

    await promptHerdrAgent(pi, "coding-m123-abcd", "/worker-run /tmp/request.json");
    const agent = await getAgent(pi, "coding-m123-abcd");
    assert.equal(agent?.pane_id, "w1:p3");
    assert.deepEqual(calls.map((call) => call.args), [
      ["agent", "prompt", "coding-m123-abcd", "/worker-run /tmp/request.json"],
      ["agent", "get", "coding-m123-abcd"],
    ]);
  });
});

test("agent lookup distinguishes a missing agent from a Herdr failure", async () => {
  await withHerdrEnv(async () => {
    const calls: ExecCall[] = [];
    const pi = fakePi([
      result(1, { error: { code: "agent_not_found", message: "not found" } }),
      result(1, { error: { code: "protocol_mismatch", message: "restart required" } }),
    ], calls);

    assert.equal(await getAgent(pi, "missing-agent"), undefined);
    await assert.rejects(getAgent(pi, "broken-agent"), /protocol_mismatch/);
  });
});

test("agent cleanup follows the named agent to its current pane", async () => {
  await withHerdrEnv(async () => {
    const calls: ExecCall[] = [];
    const pi = fakePi([
      result(0, { result: { agent: { pane_id: "w1:p9", agent: "pi" } } }),
      result(0, { result: {} }),
    ], calls);

    await closeHerdrAgent(pi, "delegate-m123-abcd", "w1:p1");
    assert.deepEqual(calls.map((call) => call.args), [
      ["agent", "get", "delegate-m123-abcd"],
      ["pane", "close", "w1:p9"],
    ]);
  });
});
