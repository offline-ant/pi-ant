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
          resultPath: paths.resultPath, statusPath: paths.statusPath, closeWhenDone: false });
        return { id, task, paths };
      }
      const first = request("first");
      target = await host.start({ kind: "pi", name: `life-${randomUUID().slice(0, 8)}`, cwd: directory, sessionFile,
        args: ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--provider", "orchestration-fixture", "--model", "one", "--thinking", "high", "-e", frame, "-e", fixture],
        env: { PI_CODING_AGENT_DIR: agentDirectory, PI_NESTED: "0" }, placement: "worker", parent, prompt: `/worker-run ${first.paths.requestPath}` });
      const managed = target;
      const nativeHost = host;
      async function wait(work: ReturnType<typeof request>) {
        return waitForWorkerResult(pi, { ...work, target: managed, sessionFile, signal: AbortSignal.timeout(20_000) });
      }
      const completed = await wait(first);
      assert.equal(completed.result.result, "fixture result: first");
      assert.equal(completed.result.retrospective, "fixture retrospective");
      assert.equal(fs.readFileSync(first.paths.resultMarkdownPath, "utf8"), completed.result.result);
      assert.equal(fs.readFileSync(first.paths.retrospectiveMarkdownPath, "utf8"), completed.result.retrospective);
      assert.equal(await host.state(target), "running");
      assert.equal(readWorkerStatus(first.paths.statusPath)?.state, "idle");
      const firstCalls = traces(directory).filter((entry) => entry.event === "request");
      assert.deepEqual(firstCalls.map((entry) => entry.tools), [["read"], []]);
      assert.equal(firstCalls[0].model, "one");
      assert.equal(firstCalls[0].reasoning, "high");

      // Machine submissions must never append to or consume the human's editor.
      if (kind === "emacs") await emacsInput(endpoint, target.id, "human draft preserved");
      else await host.send(target, { kind: "text", text: "human draft preserved", enter: false });
      await delay(200);
      const second = request("second", "two", ["bash"]);
      await host.send(target, { kind: "prompt", text: `/worker-run ${second.paths.requestPath}` });
      assert.equal((await wait(second)).result.result, "fixture result: second");
      const secondCall = traces(directory).find((entry) => entry.event === "request" && entry.prompt?.endsWith("second"));
      assert.deepEqual(secondCall?.tools, ["bash"]);
      assert.equal(secondCall?.model, "two");
      assert.equal(secondCall?.reasoning, "low");
      if (kind === "emacs") assert.equal(await emacsInput(endpoint, target.id), "human draft preserved");
      else {
        await host.send(target, { kind: "prompt", text: "/lifecycle-report" });
        await until(() => traces(directory).some((entry) => entry.event === "report"), "draft report");
        assert.equal(traces(directory).findLast((entry) => entry.event === "report")?.draft, "human draft preserved");
      }
      await host.send(target, { kind: "prompt", text: "/lifecycle-clear-draft" });
      await delay(200);

      // Takeover must happen at submission, while the slow automatic run is open.
      const supervised = request("[hold] supervised");
      await host.send(target, { kind: "prompt", text: `/worker-run ${supervised.paths.requestPath}` });
      await until(() => traces(directory).some((entry) => entry.prompt?.endsWith("[hold] supervised")), "slow worker start");
      if (kind === "emacs") await emacsInput(endpoint, target.id, "human takeover", true);
      else await host.send(target, { kind: "text", text: "human takeover", enter: true });
      await until(() => readWorkerStatus(supervised.paths.statusPath)?.state === "supervised", "human takeover before completion");
      assert.equal(fs.existsSync(supervised.paths.resultPath), false);
      fs.writeFileSync(path.join(directory, "release"), "release");
      await until(() => traces(directory).some((entry) => entry.event === "request" && entry.prompt === "human takeover"), "human follow-up runs");
      await delay(300);
      assert.equal(fs.existsSync(supervised.paths.resultPath), false);
      await host.send(target, { kind: "prompt", text: "/worker-submit supervised main" });
      const submitted = (await wait(supervised)).result;
      assert.equal(submitted.result, "supervised main");
      assert.equal(submitted.retrospective, "fixture retrospective");

      // Guidance dispatched during streaming keeps automatic capture and waits for guidance.
      fs.rmSync(path.join(directory, "release"));
      const continued = request("[hold] continued");
      await host.send(target, { kind: "prompt", text: `/worker-run ${continued.paths.requestPath}` });
      await until(() => traces(directory).some((entry) => entry.prompt?.endsWith("[hold] continued")), "continue worker start");
      await host.send(target, { kind: "prompt", text: "/worker-continue continued guidance" });
      fs.writeFileSync(path.join(directory, "release"), "release");
      assert.equal((await wait(continued)).result.result, "fixture result: continued guidance");

      const retry = request("[retry-once] retried");
      await host.send(target, { kind: "prompt", text: `/worker-run ${retry.paths.requestPath}` });
      assert.equal((await wait(retry)).result.result, "fixture result: [retry-once] retried");
      assert.equal(traces(directory).filter((entry) => entry.event === "request" && entry.prompt?.endsWith("[retry-once] retried")).length, 2);

      const beforeOverflow = traces(directory).length;
      const overflow = request("[overflow-once] recovered");
      await host.send(target, { kind: "prompt", text: `/worker-run ${overflow.paths.requestPath}` });
      await until(() => traces(directory).slice(beforeOverflow).some((entry) => entry.summary), "default overflow compaction calls faux summary provider");
      assert.equal(fs.existsSync(overflow.paths.resultPath), false, "overflow must not settle as a worker failure before compaction retries");
      assert.equal(readWorkerStatus(overflow.paths.statusPath)?.state, "running");
      assert.equal(traces(directory).slice(beforeOverflow).some((entry) => entry.event === "settled"), false);
      fs.writeFileSync(path.join(directory, "release-compaction"), "release");
      const recovered = (await wait(overflow)).result;
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
      await host.send(target, { kind: "prompt", text: `/worker-run ${retrospectiveFailure.paths.requestPath}` });
      const preserved = (await wait(retrospectiveFailure)).result;
      assert.equal(preserved.result, "fixture result: main survives");
      assert.match(preserved.retrospective ?? "", /retrospective unavailable/);
      assert.equal(preserved.isError, false);
      fs.rmSync(path.join(directory, "fail-retrospective"));

      fs.rmSync(path.join(directory, "release"));
      const override = request("[hold] override");
      await host.send(target, { kind: "prompt", text: `/worker-run ${override.paths.requestPath}` });
      await until(() => traces(directory).some((entry) => entry.prompt?.endsWith("[hold] override")), "override worker start");
      await host.send(target, { kind: "prompt", text: "/finish-worker-now explicit recovery" });
      assert.equal((await wait(override)).result.result, "explicit recovery");

      const cancelled = request("[hold] cancelled");
      await host.send(target, { kind: "prompt", text: `/worker-run ${cancelled.paths.requestPath}` });
      await until(() => traces(directory).some((entry) => entry.prompt?.endsWith("[hold] cancelled")), "cancel worker start");
      const controller = new AbortController();
      const pending = waitForWorkerResult(pi, { ...cancelled, target, sessionFile, signal: controller.signal });
      controller.abort();
      await assert.rejects(pending, /abort/i);
      await nativeHost.close(managed);
      target = undefined;
      assert.notEqual(await nativeHost.state(managed), "running", "a closed native target must not remain running");
      assert.equal(fs.existsSync(cancelled.paths.resultPath), false);
      t.diagnostic("Passed: matching result + separate retrospective, persistent model/thinking/tool changes, draft-safe request submission, busy human takeover, submit/continue/finish recovery, real retry and default overflow-compaction settlement, retrospective failure, cancelled wait and owned close.");
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
