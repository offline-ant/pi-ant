import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

interface Trace { event: string; file?: string; reason?: string; mode?: string }

async function until(check: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!check()) {
    assert.ok(Date.now() < deadline, `Timed out: ${description}`);
    await delay(20);
  }
}

test("delayed RPC switch keeps the source alive with its conversation and permits native same-file resume", { timeout: 30_000 }, async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-switch-rpc-"));
  const agentDir = path.join(directory, "agent");
  fs.mkdirSync(agentDir);
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
    defaultProvider: "switch-rpc-fixture", defaultModel: "one",
    compaction: { enabled: false }, retry: { enabled: false },
  }));
  const sessionFile = path.join(directory, "original.jsonl");
  fs.writeFileSync(sessionFile, `${JSON.stringify({
    type: "session", version: 3, id: randomUUID(), timestamp: new Date().toISOString(), cwd: directory,
  })}\n`);
  const fixture = fileURLToPath(new URL("./test/switch-rpc-fixture.ts", import.meta.url));
  const child = spawn("pi", [
    "--mode", "rpc", "--session", sessionFile,
    "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files",
    "--provider", "switch-rpc-fixture", "--model", "one", "-e", fixture,
  ], {
    cwd: directory, stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_NESTED: "", PI_ORCHESTRATION_TARGET: "", PI_ORCHESTRATION_CONTROL: "" },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (data: string) => { stdout += data; });
  child.stderr.setEncoding("utf8").on("data", (data: string) => { stderr += data; });
  const closed = once(child, "close");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await closed;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const traces = (): Trace[] => {
    const file = path.join(directory, "trace.jsonl");
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Trace) : [];
  };
  try {
    await until(() => traces().some((entry) => entry.event === "start" && entry.file === sessionFile), "initial session startup");
    assert.equal(traces()[0]?.mode, "rpc");
    // The destination is delayed while the source runtime is replaced. The
    // process and its same-file conversation must remain available afterward.
    child.stdin.write(`${JSON.stringify({ id: "switch", type: "prompt", message: "/switch herdr" })}\n`);
    await until(() => traces().some((entry) => entry.event === "destination-start"), "delayed destination launch");
    const releasedBytes = fs.readFileSync(sessionFile, "utf8");
    await delay(250);
    assert.equal(child.exitCode, null);
    assert.equal(child.signalCode, null);
    fs.writeFileSync(path.join(directory, "release"), "ready");
    await until(() => stdout.includes("This view stays open"), "destination notice reaches the RPC frontend");
    assert.equal(child.exitCode, null);
    assert.equal(child.signalCode, null);
    assert.ok(stdout.includes("/resume"));
    const events = traces();
    assert.deepEqual(events.map((entry) => entry.event), [
      "start", "shutdown-start", "shutdown-complete", "start", "destination-start", "destination-ready",
    ]);
    assert.equal(events[2]?.file, sessionFile);
    assert.equal(events[2]?.reason, "resume");
    assert.equal(events[3]?.file, sessionFile);
    assert.equal(fs.readFileSync(sessionFile, "utf8"), releasedBytes, "status does not append stale source entries");

    child.stdin.write(`${JSON.stringify({ id: "state", type: "get_state" })}\n`);
    await until(() => stdout.split("\n").some((line) => line.includes('"id":"state"')), "RPC source still answers commands");
    const state = JSON.parse(stdout.split("\n").find((line) => line.includes('"id":"state"'))!) as { success: boolean; data: { sessionFile: string } };
    assert.equal(state.success, true);
    assert.equal(state.data.sessionFile, sessionFile);
    child.stdin.write(`${JSON.stringify({ id: "resume", type: "switch_session", sessionPath: sessionFile })}\n`);
    await until(() => stdout.split("\n").some((line) => line.includes('"id":"resume"')), "native same-file RPC resume succeeds");
    const resumed = JSON.parse(stdout.split("\n").find((line) => line.includes('"id":"resume"'))!) as { success: boolean; data: { cancelled: boolean } };
    assert.equal(resumed.success, true);
    assert.equal(resumed.data.cancelled, false);
    assert.equal(child.exitCode, null);
    assert.equal(child.signalCode, null);
    assert.doesNotMatch(stdout, /"type":"(?:agent_start|agent_settled|extension_error)"/);
  } catch (error) {
    t.diagnostic(`RPC stdout: ${stdout}\nRPC stderr: ${stderr}\nTrace: ${JSON.stringify(traces())}`);
    throw error;
  }
});
