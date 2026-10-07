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
import type { Host, HostTarget } from "../host-types.ts";
import { createWorkerArtifacts, readWorkerStatus, writeWorkerRequest, type WorkerArtifactPaths } from "../worker-frame.ts";
import { waitForWorkerResult } from "../workers.ts";
import { createTmuxHost } from "./tmux.ts";
import { createHerdrHost } from "./herdr.ts";
import { createEmacsHost } from "./emacs.ts";

const exec = promisify(execFile);
const native = process.env.PI_LIFECYCLE_SMOKE === "1";
const frame = fileURLToPath(new URL("../worker-frame.ts", import.meta.url));
const fixture = fileURLToPath(new URL("../test/lifecycle-fixture.ts", import.meta.url));
const emacsFixture = fileURLToPath(new URL("../test/lifecycle-emacs.el", import.meta.url));
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

interface Trace {
  event: string;
  prompt?: string;
  retrospective?: boolean;
  summary?: boolean;
  reason?: string;
  willRetry?: boolean;
  fromExtension?: boolean;
  tools?: string[];
  model?: string;
  reasoning?: string;
  draft?: string;
  idle?: boolean;
  source?: string;
}
function traces(directory: string): Trace[] {
  const file = path.join(directory, "lifecycle-trace.jsonl");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Trace) : [];
}
async function until(predicate: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await delay(50);
  }
}
async function emacsInput(endpoint: string, id: string, text?: string, send = false): Promise<string> {
  const data = Buffer.from(JSON.stringify({ id, text, send })).toString("base64");
  const result = await exec("emacsclient", ["--socket-name", endpoint, "--eval", `(pi-lifecycle-input "${data}")`]);
  return Buffer.from(JSON.parse(result.stdout) as string, "base64").toString("utf8");
}

for (const kind of ["tmux", "herdr", "emacs"] as const) {
  test(`${kind}: real Pi structured lifecycle with only faux provider`, { skip: !native, timeout: 180_000 }, async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lifecycle-"));
    const endpoint = kind === "tmux" ? path.join(directory, "tmux.sock")
      : kind === "herdr" ? process.env.HERDR_SOCKET_PATH : path.join(directory, "emacs.sock");
    assert.ok(endpoint, "Herdr lifecycle test must run with HERDR_SOCKET_PATH");
    let host: Host | undefined;
    let parent: HostTarget | undefined;
    let target: HostTarget | undefined;
    let ownedServer = false;
    const artifacts: WorkerArtifactPaths[] = [];
    try {
      if (kind === "tmux") {
        await exec("tmux", ["-S", endpoint, "new-session", "-d", "-s", "lifecycle", "-x", "110", "-y", "35"]);
        ownedServer = true;
        const id = (await exec("tmux", ["-S", endpoint, "display-message", "-p", "-t", "lifecycle", "#{pane_id}"])).stdout.trim();
        parent = { host: kind, endpoint, id, paneId: id, kind: "pi", name: "parent" };
        host = createTmuxHost(pi, endpoint);
      } else if (kind === "herdr") {
        host = createHerdrHost(pi, endpoint);
        parent = host.parent();
      } else {
        await exec("emacs", ["-Q", `--daemon=${endpoint}`, "-l", emacsFixture], { timeout: 30_000 });
        ownedServer = true;
        host = createEmacsHost(pi, endpoint);
      }
      const sessionFile = path.join(directory, "session.jsonl");
      fs.writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: randomUUID(), timestamp: new Date().toISOString(), cwd: directory })}\n`);
      const agentDirectory = path.join(directory, "agent");
      fs.mkdirSync(agentDirectory);
      fs.writeFileSync(path.join(agentDirectory, "settings.json"), JSON.stringify({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 20 }, compaction: { enabled: true, reserveTokens: 1024, keepRecentTokens: 32 } }));
      function request(task: string, model = "one", tools = ["read"]) {
        const paths = createWorkerArtifacts();
        artifacts.push(paths);
        const id = randomUUID();
        writeWorkerRequest(paths, { id, task, tools, model: { provider: "orchestration-fixture", id: model }, thinkingLevel: model === "one" ? "high" : "low",
          resultPath: paths.resultPath, statusPath: paths.statusPath });
        return { id, task, paths };
      }
      const nativeHost = host;
      const args = ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--provider", "orchestration-fixture", "--model", "one", "--thinking", "high", "-e", frame, "-e", fixture];
      async function start(prompt?: string): Promise<HostTarget> {
        target = await nativeHost.start({ kind: "pi", name: `life-${randomUUID().slice(0, 8)}`, cwd: directory, sessionFile, args,
          env: { PI_CODING_AGENT_DIR: agentDirectory, PI_NESTED: "0" }, placement: "worker", parent, prompt });
        return target;
      }
      const run = (work: ReturnType<typeof request>) => start(`/worker-run ${work.paths.requestPath}`);
      // Every worker process closes itself after writing its final result.
      async function wait(work: ReturnType<typeof request>, worker: HostTarget) {
        const output = await waitForWorkerResult(pi, { ...work, target: worker, sessionFile, signal: AbortSignal.timeout(20_000) });
        await until(async () => await nativeHost.state(worker) !== "running", "worker closes after its result");
        assert.equal(readWorkerStatus(work.paths.statusPath)?.state, "closed");
        target = undefined;
        return output;
      }

      const first = request("first");
      const completed = await wait(first, await run(first));
      assert.equal(completed.result.result, "fixture result: first");
      assert.equal(completed.result.retrospective, "fixture retrospective");
      assert.equal(fs.readFileSync(first.paths.resultMarkdownPath, "utf8"), completed.result.result);
      assert.equal(fs.readFileSync(first.paths.retrospectiveMarkdownPath, "utf8"), completed.result.retrospective);
      const firstCalls = traces(directory).filter((entry) => entry.event === "request");
      assert.deepEqual(firstCalls.map((entry) => entry.tools), [["read"], ["read"]]);
      assert.equal(firstCalls[0].model, "one");
      assert.equal(firstCalls[0].reasoning, "high");

      const second = request("second", "two", ["bash"]);
      assert.equal((await wait(second, await run(second))).result.result, "fixture result: second");
      const secondCall = traces(directory).find((entry) => entry.event === "request" && entry.prompt?.endsWith("second"));
      assert.deepEqual(secondCall?.tools, ["bash"]);
      assert.equal(secondCall?.model, "two");
      assert.equal(secondCall?.reasoning, "low");

      // Machine submissions must never append to or consume the human's editor.
      const startups = () => traces(directory).filter((entry) => entry.event === "startup").length;
      const startupsBefore = startups();
      const idle = await start();
      await until(() => startups() > startupsBefore, "idle target startup");
      if (kind === "emacs") await emacsInput(endpoint, idle.id, "human draft preserved");
      else await host.send(idle, { kind: "text", text: "human draft preserved", enter: false });
      await delay(200);
      await host.send(idle, { kind: "prompt", text: "/lifecycle-report" });
      await until(() => traces(directory).some((entry) => entry.event === "report"), "draft report");
      if (kind === "emacs") assert.equal(await emacsInput(endpoint, idle.id), "human draft preserved");
      else assert.equal(traces(directory).findLast((entry) => entry.event === "report")?.draft, "human draft preserved");
      await host.close(idle);
      target = undefined;

      // Takeover must happen at submission, while the slow automatic run is open.
      const supervised = request("[hold] supervised");
      const supervisedWorker = await run(supervised);
      await until(() => traces(directory).some((entry) => entry.prompt?.endsWith("[hold] supervised")), "slow worker start");
      if (kind === "emacs") await host.send(supervisedWorker, { kind: "prompt", text: "human takeover" });
      else await host.send(supervisedWorker, { kind: "text", text: "human takeover", enter: true });
      await until(() => readWorkerStatus(supervised.paths.statusPath)?.state === "supervised", "human takeover before completion");
      assert.equal(fs.existsSync(supervised.paths.resultPath), false);
      fs.writeFileSync(path.join(directory, "release"), "release");
      await until(() => traces(directory).some((entry) => entry.event === "request" && entry.prompt === "human takeover"), "human follow-up runs");
      await delay(300);
      assert.equal(fs.existsSync(supervised.paths.resultPath), false);
      await host.send(supervisedWorker, { kind: "prompt", text: "/worker-submit supervised main" });
      const submitted = (await wait(supervised, supervisedWorker)).result;
      assert.equal(submitted.result, "supervised main");
      assert.equal(submitted.retrospective, "fixture retrospective");

      // Guidance dispatched during streaming keeps automatic capture and waits for guidance.
      fs.rmSync(path.join(directory, "release"));
      const continued = request("[hold] continued");
      const continuedWorker = await run(continued);
      await until(() => traces(directory).some((entry) => entry.prompt?.endsWith("[hold] continued")), "continue worker start");
      await host.send(continuedWorker, { kind: "prompt", text: "/worker-continue continued guidance" });
      fs.writeFileSync(path.join(directory, "release"), "release");
      assert.equal((await wait(continued, continuedWorker)).result.result, "fixture result: continued guidance");

      const retry = request("[retry-once] retried");
      assert.equal((await wait(retry, await run(retry))).result.result, "fixture result: [retry-once] retried");
      assert.equal(traces(directory).filter((entry) => entry.event === "request" && entry.prompt?.endsWith("[retry-once] retried")).length, 2);

      // Terminal quota rejection must preserve the live worker for explicit recovery.
      for (const recovery of ["continue", "finish"] as const) {
        const beforeQuota = traces(directory).length;
        const quota = request(`[quota] ${recovery}`);
        const quotaWorker = await run(quota);
        await until(() => readWorkerStatus(quota.paths.statusPath)?.state === "supervised"
          && traces(directory).slice(beforeQuota).some((entry) => entry.event === "settled"), "quota rejection settles into supervision");
        assert.equal(await nativeHost.state(quotaWorker), "running", "quota rejection must not close the worker");
        assert.equal(fs.existsSync(quota.paths.resultPath), false, "quota rejection must not publish a failed result");
        assert.equal(fs.existsSync(quota.paths.resultMarkdownPath), false);
        assert.match(readWorkerStatus(quota.paths.statusPath)?.supervisionReason ?? "", /429 quota exceeded: fixture subscription usage limit/);
        assert.doesNotMatch(readWorkerStatus(quota.paths.statusPath)?.supervisionReason ?? "", /fixture partial response/);
        assert.equal(traces(directory).slice(beforeQuota).filter((entry) => entry.event === "request").length, 1,
          "quota exhaustion must not automatically retry or start a retrospective");

        const guidance = `quota ${recovery} recovery`;
        await host.send(quotaWorker, { kind: "prompt", text: recovery === "continue"
          ? `/worker-continue ${guidance}` : `/finish-worker-now ${guidance}` });
        const quotaResult = (await wait(quota, quotaWorker)).result;
        assert.equal(quotaResult.isError, false);
        assert.equal(quotaResult.result, recovery === "continue" ? `fixture result: ${guidance}` : guidance);
        assert.equal(quotaResult.retrospective, recovery === "continue"
          ? "fixture retrospective" : "retrospective bypassed by /finish-worker-now.");
        assert.equal(traces(directory).slice(beforeQuota).filter((entry) => entry.event === "request").length,
          recovery === "continue" ? 3 : 1, "finishing a quota-blocked worker must not require another model request");
      }

      const beforeOverflow = traces(directory).length;
      const overflow = request("[overflow-once] recovered");
      const overflowWorker = await run(overflow);
      await until(() => traces(directory).slice(beforeOverflow).some((entry) => entry.summary), "default overflow compaction calls faux summary provider");
      assert.equal(fs.existsSync(overflow.paths.resultPath), false, "overflow must not settle as a worker failure before compaction retries");
      assert.equal(readWorkerStatus(overflow.paths.statusPath)?.state, "running");
      assert.equal(traces(directory).slice(beforeOverflow).some((entry) => entry.event === "settled"), false);
      fs.writeFileSync(path.join(directory, "release-compaction"), "release");
      const recovered = (await wait(overflow, overflowWorker)).result;
      assert.equal(recovered.result, "fixture result: [overflow-once] recovered");
      assert.equal(recovered.retrospective, "fixture retrospective");
      const recoveryTrace = traces(directory).slice(beforeOverflow);
      assert.equal(recoveryTrace.filter((entry) => entry.event === "request" && !entry.summary && entry.prompt?.endsWith("[overflow-once] recovered")).length, 2);
      const compacted = recoveryTrace.find((entry) => entry.event === "compacted");
      assert.equal(compacted?.reason, "overflow");
      assert.equal(compacted?.willRetry, true);
      assert.equal(compacted?.fromExtension, false, "exercise Pi's default compaction, not a hook-provided checkpoint");
      assert.equal(recoveryTrace.some((entry) => entry.event === "compaction-failed"), false);
      assert.ok(fs.readFileSync(sessionFile, "utf8").split("\n").filter(Boolean).some((line) => (JSON.parse(line) as { type: string }).type === "compaction"));

      fs.writeFileSync(path.join(directory, "fail-retrospective"), "fail");
      const retrospectiveFailure = request("main survives");
      const preserved = (await wait(retrospectiveFailure, await run(retrospectiveFailure))).result;
      assert.equal(preserved.result, "fixture result: main survives");
      assert.match(preserved.retrospective ?? "", /retrospective unavailable/);
      assert.equal(preserved.isError, false);
      fs.rmSync(path.join(directory, "fail-retrospective"));

      fs.rmSync(path.join(directory, "release"));
      const override = request("[hold] override");
      const overrideWorker = await run(override);
      await until(() => traces(directory).some((entry) => entry.prompt?.endsWith("[hold] override")), "override worker start");
      await host.send(overrideWorker, { kind: "prompt", text: "/finish-worker-now explicit recovery" });
      assert.equal((await wait(override, overrideWorker)).result.result, "explicit recovery");

      const cancelled = request("[hold] cancelled");
      const cancelledWorker = await run(cancelled);
      await until(() => traces(directory).some((entry) => entry.prompt?.endsWith("[hold] cancelled")), "cancel worker start");
      const controller = new AbortController();
      const pending = waitForWorkerResult(pi, { ...cancelled, target: cancelledWorker, sessionFile, signal: controller.signal });
      controller.abort();
      await assert.rejects(pending, /abort/i);
      await nativeHost.close(cancelledWorker);
      target = undefined;
      assert.notEqual(await nativeHost.state(cancelledWorker), "running", "a closed native target must not remain running");
      assert.equal(fs.existsSync(cancelled.paths.resultPath), false);
      t.diagnostic("Passed: matching result + separate retrospective, self-closing workers, per-request model/thinking/tool selection, draft-safe prompt submission, busy human takeover, submit/continue/finish recovery, quota rejection retains live supervision with explicit continue/finish recovery, real retry and default overflow-compaction settlement, retrospective failure, cancelled wait and owned close.");
    } catch (error) {
      t.diagnostic(`Fixture trace: ${JSON.stringify(traces(directory))}`);
      if (host && target) t.diagnostic(`Native output: ${await host.read(target, 80).catch(String)}`);
      throw error;
    } finally {
      if (host && target) await host.close(target);
      if (ownedServer && kind === "tmux") await exec("tmux", ["-S", endpoint, "kill-server"]);
      if (ownedServer && kind === "emacs") await exec("emacsclient", ["--socket-name", endpoint, "--eval", "(kill-emacs)"]);
      for (const paths of artifacts) fs.rmSync(paths.artifactDir, { recursive: true, force: true });
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}
