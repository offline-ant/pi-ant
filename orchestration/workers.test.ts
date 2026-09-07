import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import codingAgentExtension from "./extensions/coding-agent.ts";
import type { HostTarget } from "./host-types.ts";
import { createWorkerArtifacts, writeWorkerRequest, type WorkerRequestFile } from "./worker-frame.ts";
import { claimName, listTargets, readTarget, removeTarget, runEphemeralWorker, saveTarget, validateName, waitForWorkerResult } from "./workers.ts";

const target = (name: string): HostTarget => ({ host: "tmux", endpoint: "/tmp/fake-orchestration", id: "%2", kind: "pi", name });

test("logical names are exclusively claimed and all target kinds share one registry", () => {
  const name = `registry-${process.pid}`;
  const release = claimName(name);
  try {
    assert.throws(() => claimName(name), /already being used/);
    saveTarget(target(name));
    assert.deepEqual(readTarget(name), target(name));
    assert.ok(listTargets().some((entry) => entry.name === name));
    assert.throws(() => validateName("../bad"), /Name must/);
  } finally { removeTarget(name); release(); }
  release();
  claimName(name)();
});

test("matching result is completion even when the process exits during native state I/O", async () => {
  const paths = createWorkerArtifacts();
  const pi = { exec: async () => {
    fs.writeFileSync(paths.resultPath, JSON.stringify({ id: "matching", result: "Result", retrospective: "Notes", timestamp: new Date().toISOString() }));
    return { code: 0, stdout: "1", stderr: "", killed: false };
  } } as unknown as ExtensionAPI;
  try {
    const output = await waitForWorkerResult(pi, { id: "matching", target: target("matching"), paths, task: "Task", sessionFile: "/tmp/test.jsonl" });
    assert.equal(output.result.result, "Result");
    assert.equal(output.result.retrospective, "Notes");
    assert.deepEqual(output.details.target, target("matching"));
  } finally { fs.rmSync(paths.artifactDir, { recursive: true, force: true }); }
});

test("process death without a result and mismatched late artifacts are failures", async () => {
  const paths = createWorkerArtifacts();
  const pi = { exec: async () => ({ code: 0, stdout: "1", stderr: "", killed: false }) } as unknown as ExtensionAPI;
  try {
    const options = { id: "current", target: target("current"), paths, task: "Task", sessionFile: "/tmp/test.jsonl" };
    await assert.rejects(waitForWorkerResult(pi, options), /exited before writing a final result/);
    fs.writeFileSync(paths.resultPath, JSON.stringify({ id: "late", result: "Old", timestamp: new Date().toISOString() }));
    await assert.rejects(waitForWorkerResult(pi, options), /id mismatch/);
  } finally { fs.rmSync(paths.artifactDir, { recursive: true, force: true }); }
});

interface FakePane { server: net.Server; dead: boolean }
function fakeTmux(onRequest: (request: WorkerRequestFile) => void) {
  const panes = new Map<string, FakePane>();
  const requests: WorkerRequestFile[] = [];
  const startupArgs: string[][] = [];
  const closes: string[] = [];
  let next = 10;
  const pi = {
    exec: async (_command: string, args: string[]) => {
      const command = args[2];
      let stdout = "";
      if (command === "new-window") {
        startupArgs.push(args);
        const id = `%${next++}`;
        const control = args.find((arg) => arg.startsWith("PI_ORCHESTRATION_CONTROL="))?.split("=")[1];
        assert.ok(control);
        const server = net.createServer((socket) => {
          let data = "";
          socket.on("data", (chunk) => {
            data += chunk.toString();
            if (!data.endsWith("\n")) return;
            const input = JSON.parse(data) as { kind: string; text?: string };
            if (input.kind === "prompt") {
              const request = JSON.parse(fs.readFileSync(input.text!.slice("/worker-run ".length), "utf8")) as WorkerRequestFile;
              requests.push(request);
              onRequest(request);
            }
            socket.end('{"dispatched":true}');
          });
        });
        await new Promise<void>((resolve) => server.listen(control, resolve));
        panes.set(id, { server, dead: false });
        stdout = id;
      } else if (command === "display-message") {
        stdout = panes.get(args[5])?.dead ? "1" : "0";
      } else if (command === "kill-pane") {
        const id = args[4];
        closes.push(id);
        const pane = panes.get(id);
        if (pane) { pane.dead = true; await new Promise<void>((resolve) => pane.server.close(() => resolve())); }
      } else if (command === "capture-pane") {
        stdout = "Bounded worker preview\n".repeat(1000);
      }
      return { code: 0, stdout, stderr: "", killed: false };
    },
    events: { on: () => () => {} },
    on: () => {},
    getActiveTools: () => ["read"],
    getThinkingLevel: () => "high",
  } as unknown as ExtensionAPI;
  return { pi, requests, startupArgs, closes, cleanup: async () => {
    for (const pane of panes.values()) if (!pane.dead) await new Promise<void>((resolve) => pane.server.close(() => resolve()));
  } };
}

function complete(request: WorkerRequestFile): void {
  fs.writeFileSync(request.resultPath, JSON.stringify({ id: request.id, result: request.task, retrospective: "everything was ok", timestamp: new Date().toISOString() }));
  if (request.statusPath) fs.writeFileSync(request.statusPath, JSON.stringify({ id: request.id, state: "idle", updatedAt: new Date().toISOString() }));
}

function selectFakeTmux(): () => void {
  const keys = ["PI_ORCHESTRATION_HOST", "PI_ORCHESTRATION_ENDPOINT", "TMUX_PANE"];
  const before = keys.map((key) => process.env[key]);
  process.env.PI_ORCHESTRATION_HOST = "tmux";
  process.env.PI_ORCHESTRATION_ENDPOINT = "/tmp/fake-orchestration";
  process.env.TMUX_PANE = "%1";
  return () => keys.forEach((key, index) => {
    if (before[index] === undefined) delete process.env[key]; else process.env[key] = before[index];
  });
}

test("ephemeral siblings overlap their task lifetimes, inherit launch arguments, preview, and close", async () => {
  const restore = selectFakeTmux();
  const pending: WorkerRequestFile[] = [];
  const fake = fakeTmux((request) => { pending.push(request); if (pending.length === 2) pending.forEach(complete); });
  const first = createWorkerArtifacts();
  const second = createWorkerArtifacts();
  const updates: unknown[] = [];
  try {
    const run = (paths: typeof first, index: number) => {
      const id = `parallel-${process.pid}-${index}`;
      writeWorkerRequest(paths, { id, task: id, tools: ["read", "delegate"], model: { provider: "fake", id: "fake" }, thinkingLevel: "high", resultPath: paths.resultPath, statusPath: paths.statusPath, closeWhenDone: true });
      return runEphemeralWorker(fake.pi, { id, name: id, cwd: "/tmp", sessionFile: path.join(paths.artifactDir, "session.jsonl"), args: ["--provider", "fake", "--model", "fake", "--thinking", "high"], paths, task: id, onUpdate: (update) => updates.push(update) });
    };
    const results = await Promise.all([run(first, 1), run(second, 2)]);
    assert.equal(pending.length, 2);
    assert.equal(fake.closes.length, 2);
    assert.ok(fake.startupArgs.every((args) => args.at(-1)?.includes("'--thinking' 'high'")));
    assert.equal(results[0].result.retrospective, "everything was ok");
    assert.equal(readTarget(`parallel-${process.pid}-1`), undefined);
    assert.ok(updates.length > 0);
    assert.ok(JSON.stringify(updates).length < 12000);
  } finally {
    await fake.cleanup(); restore();
    fs.rmSync(first.artifactDir, { recursive: true, force: true });
    fs.rmSync(second.artifactDir, { recursive: true, force: true });
  }
});

test("cancellation closes ephemeral work instead of abandoning its wait", async () => {
  const restore = selectFakeTmux();
  const abort = new AbortController();
  const fake = fakeTmux(() => { setTimeout(() => abort.abort(), 20); });
  const paths = createWorkerArtifacts();
  const name = `cancel-${process.pid}`;
  try {
    writeWorkerRequest(paths, { id: name, task: "wait", tools: ["read"], model: { provider: "fake", id: "fake" }, thinkingLevel: "high", resultPath: paths.resultPath, closeWhenDone: true });
    await assert.rejects(runEphemeralWorker(fake.pi, { id: name, name, cwd: "/tmp", sessionFile: "/tmp/fake-session.jsonl", args: [], paths, task: "wait", signal: abort.signal }), /abort/i);
    assert.equal(fake.closes.length, 1);
    assert.equal(readTarget(name), undefined);
    claimName(name)();
  } finally { await fake.cleanup(); restore(); fs.rmSync(paths.artifactDir, { recursive: true, force: true }); }
});

test("cleanup failure retains the original protocol error, target, and recovery artifacts", async () => {
  const restore = selectFakeTmux();
  const fake = fakeTmux((request) => complete({ ...request, id: "late" }));
  const exec = fake.pi.exec;
  fake.pi.exec = async (command, args, options) => args[2] === "kill-pane"
    ? { code: 1, stdout: "", stderr: "Host close failed", killed: false }
    : exec(command, args, options);
  const paths = createWorkerArtifacts();
  const name = `close-error-${process.pid}`;
  try {
    writeWorkerRequest(paths, { id: name, task: "wait", tools: ["read"], model: { provider: "fake", id: "fake" }, thinkingLevel: "high", resultPath: paths.resultPath, closeWhenDone: true });
    await assert.rejects(runEphemeralWorker(fake.pi, { id: name, name, cwd: "/tmp", sessionFile: "/tmp/fake-session.jsonl", args: [], paths, task: "wait" }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /id mismatch/);
      assert.match(error.message, /Could not close worker/);
      assert.ok(error.message.includes(paths.artifactDir));
      return true;
    });
    assert.ok(readTarget(name), "failed cleanup must retain the target for recovery");
    claimName(name)();
  } finally {
    const owned = readTarget(name);
    await fake.cleanup();
    if (owned?.controlPath) fs.rmSync(path.dirname(owned.controlPath), { recursive: true, force: true });
    removeTarget(name); restore(); fs.rmSync(paths.artifactDir, { recursive: true, force: true });
  }
});

test("persistent calls reuse one target, reject simultaneous same-name use, and cancel owned work", async () => {
  const restore = selectFakeTmux();
  let hold = false;
  const fake = fakeTmux((request) => { if (!hold) complete(request); });
  type Execute = (id: string, params: { name: string; task: string }, signal: AbortSignal | undefined, update: undefined, ctx: ExtensionContext) => Promise<unknown>;
  let execute: Execute | undefined;
  fake.pi.registerTool = ((tool: { execute: Execute }) => { execute = tool.execute; }) as ExtensionAPI["registerTool"];
  codingAgentExtension(fake.pi);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "persistent-test-"));
  const ctx = { cwd: root, model: { provider: "fake", id: "fake" }, thinkingLevel: "high" } as unknown as ExtensionContext;
  const name = `persistent-${process.pid}`;
  let sessionFile: string | undefined;
  try {
    assert.ok(execute);
    await execute("one", { name, task: "First" }, undefined, undefined, ctx);
    sessionFile = readTarget(name)?.sessionFile;
    await execute("two", { name, task: "Second" }, undefined, undefined, ctx);
    assert.equal(fake.startupArgs.length, 1);
    assert.equal(fake.requests.length, 2);
    assert.equal(fake.closes.length, 0);
    hold = true;
    const abort = new AbortController();
    const pending = execute("three", { name, task: "Held" }, abort.signal, undefined, ctx);
    await delay(20);
    await assert.rejects(execute("four", { name, task: "Collision" }, undefined, undefined, ctx), /already being used/);
    abort.abort();
    await assert.rejects(pending, /abort/i);
    assert.equal(fake.closes.length, 1);
    assert.equal(readTarget(name), undefined);
    claimName(name)();
  } finally {
    await fake.cleanup(); restore(); removeTarget(name);
    for (const request of fake.requests) fs.rmSync(path.dirname(request.resultPath), { recursive: true, force: true });
    if (sessionFile) fs.rmSync(sessionFile, { force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});
