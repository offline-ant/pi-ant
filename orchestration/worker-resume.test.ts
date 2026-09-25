import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { flushSessionFile } from "./context.ts";
import { workerResumeCommand } from "./worker-resume.ts";

const exec = promisify(execFile);

test("resume shell command quotes paths and does not reproduce private launch flags or host credentials", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-resume-quote-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const old = process.env.PI_CODING_AGENT_DIR;
  t.after(() => {
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = old;
  });
  const file = path.join(root, "worker's $(echo bad); session.jsonl");
  const agentDir = path.join(root, "agent's config");
  process.env.PI_CODING_AGENT_DIR = path.relative(process.cwd(), agentDir);
  fs.writeFileSync(path.join(root, "pi"), '#!/bin/sh\nprintf "%s\\n" "$PI_CODING_AGENT_DIR" "$@"\n', { mode: 0o700 });
  const command = workerResumeCommand(file);
  const result = await exec("/bin/sh", ["-c", command], { env: { ...process.env, PATH: `${root}:${process.env.PATH}` } });
  assert.deepEqual(result.stdout.trim().split("\n"), [agentDir, "--session", file]);
  assert.doesNotMatch(command, /worker-run|worker-frame|--no-context|--provider|--model|PI_ORCHESTRATION_ENDPOINT/);
  delete process.env.PI_CODING_AGENT_DIR;
  assert.doesNotMatch(workerResumeCommand(file), /PI_CODING_AGENT_DIR=/);
});

test("offered command reopens persisted worker history with normal resources and usable tools in its saved cwd", { timeout: 30_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-resume-cli-"));
  const cwd = path.join(root, "worker's project");
  const agentDir = path.join(root, "private agent");
  fs.mkdirSync(cwd);
  fs.mkdirSync(agentDir);
  fs.writeFileSync(path.join(cwd, "resume-proof.txt"), "correct worker cwd");
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = old;
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
    extensions: [
      fileURLToPath(new URL("./worker-frame.ts", import.meta.url)),
      fileURLToPath(new URL("./test/worker-resume-fixture.ts", import.meta.url)),
    ],
    compaction: { enabled: false }, retry: { enabled: false },
  }));
  // Native provider registration refreshes auth availability asynchronously.
  // Configure dummy auth before startup so restoring the saved model cannot race
  // that refresh. Streaming still uses only the in-process faux provider.
  fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
    providers: { "worker-resume-fixture": { apiKey: "offline-resume-fixture" } },
  }));
  const session = SessionManager.create(cwd, root);
  session.appendCustomEntry("pi-orchestration:delegate", { tool: "fresh_look", context: "clean" });
  session.appendModelChange("worker-resume-fixture", "resume");
  session.appendThinkingLevelChange("off");
  session.appendMessage({ role: "user", content: "saved worker progress", timestamp: Date.now() });
  const file = session.getSessionFile()!;
  flushSessionFile(session, file);
  const originalEntries = session.getEntries();
  // Run exactly the offered shell command, adding only non-interactive mode and
  // an explicit user prompt. No private worker extension flags or /worker-run.
  const command = `${workerResumeCommand(file)} --mode json -p 'Continue the saved work'`;
  const execution = exec("/bin/sh", ["-c", command], {
    cwd: root, timeout: 25_000, maxBuffer: 1024 * 1024,
    // No user credentials, provider environment, or global home resources.
    env: { PATH: process.env.PATH, HOME: root, PI_OFFLINE: "1", PI_NESTED: "3",
      PI_ORCHESTRATION_CONTROL: "/must-not-bind.sock", PI_ORCHESTRATION_TARGET: "old-worker" },
  });
  execution.child.stdin?.end();
  const { stdout, stderr } = await execution;
  assert.equal(stderr, "", stdout);
  assert.match(stdout, /resumed ordinary session/);
  assert.doesNotMatch(stdout, /retrospective|Could not start worker request/);
  const resumed = SessionManager.open(file);
  assert.equal(resumed.getCwd(), cwd);
  assert.deepEqual(resumed.getEntries().slice(0, originalEntries.length), originalEntries);
  assert.ok(resumed.getEntries().length > originalEntries.length, "resume appends to the existing transcript");
});
