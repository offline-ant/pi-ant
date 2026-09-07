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
import { readTarget, removeTarget } from "../workers.ts";
import { createTmuxHost } from "./tmux.ts";
import { createHerdrHost } from "./herdr.ts";
import { createEmacsHost } from "./emacs.ts";

const exec = promisify(execFile);
const enabled = process.env.PI_FORK_SMOKE === "1";
const orchestration = fileURLToPath(new URL("../", import.meta.url));
const root = fileURLToPath(new URL("../../", import.meta.url));
const fixture = fileURLToPath(new URL("../test/lifecycle-fixture.ts", import.meta.url));
const emacsFixture = fileURLToPath(new URL("../test/lifecycle-emacs.el", import.meta.url));
const pi = {
  async exec(command: string, args: string[], options: ExecOptions = {}) {
    try { return { ...await exec(command, args, { timeout: options.timeout, signal: options.signal }), code: 0, killed: false }; }
    catch (error) {
      const failure = error as Error & { stdout?: string; stderr?: string; code?: number; killed?: boolean };
      return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? failure.message, code: failure.code ?? 1, killed: failure.killed ?? false };
    }
  },
} as unknown as ExtensionAPI;

interface Report {
  event: string;
  session: string;
  provider: string;
  model: string;
  thinking: string;
  tools: string[];
  commands: string[];
  leaf: string;
  draft: string;
  idle: boolean;
  prompt?: string;
}

for (const kind of ["tmux", "herdr", "emacs"] as const) {
  test(`${kind}: public fork-here preserves parent and inherits isolated faux runtime`, { skip: !enabled, timeout: 120_000 }, async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fork-native-"));
    const agentDirectory = path.join(directory, "agent");
    fs.mkdirSync(agentDirectory);
    fs.writeFileSync(path.join(agentDirectory, "settings.json"), JSON.stringify({
      packages: [orchestration, root], extensions: [fixture], compaction: { enabled: false },
      defaultProvider: "orchestration-fixture", defaultModel: "two", defaultThinkingLevel: "low",
    }));
    const endpoint = kind === "tmux" ? path.join(directory, "tmux.sock")
      : kind === "herdr" ? process.env.HERDR_SOCKET_PATH : path.join(directory, "emacs.sock");
    assert.ok(endpoint, "Herdr smoke needs HERDR_SOCKET_PATH");
    const names = ["idle", "prompted"].map((suffix) => `fork-native-${randomUUID().slice(0, 6)}-${suffix}`);
    let host: Host | undefined;
    let parent: HostTarget | undefined;
    let owner: HostTarget | undefined;
    let server = false;
    let ownedHerdrTab: string | undefined;
    const reports = (): Report[] => {
      const file = path.join(directory, "lifecycle-trace.jsonl");
      return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Report) : [];
    };
    const until = async (predicate: () => boolean, label: string): Promise<void> => {
      const deadline = Date.now() + 40_000;
      while (!predicate()) {
        if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
        await delay(50);
      }
    };
    const input = async (target: HostTarget, text?: string): Promise<string> => {
      const data = Buffer.from(JSON.stringify({ id: target.id, text })).toString("base64");
      const result = await exec("emacsclient", ["--socket-name", endpoint, "--eval", `(pi-lifecycle-input "${data}")`]);
      return Buffer.from(JSON.parse(result.stdout) as string, "base64").toString("utf8");
    };
    try {
      if (kind === "tmux") {
        await exec("tmux", ["-S", endpoint, "new-session", "-d", "-s", "forks", "-x", "110", "-y", "35"], { env: { ...process.env, PI_CODING_AGENT_DIR: agentDirectory } });
        server = true;
        const id = (await exec("tmux", ["-S", endpoint, "display-message", "-p", "-t", "forks", "#{pane_id}"])).stdout.trim();
        parent = { host: kind, endpoint, id, paneId: id, kind: "pi", name: "parent" };
        host = createTmuxHost(pi, endpoint);
      } else if (kind === "herdr") {
        host = createHerdrHost(pi, endpoint);
        parent = host.parent();
      } else {
        await exec("emacs", ["-Q", `--daemon=${endpoint}`, "-l", emacsFixture], { timeout: 30_000, env: { ...process.env, PI_CODING_AGENT_DIR: agentDirectory } });
        server = true;
        host = createEmacsHost(pi, endpoint);
      }
      const sessionFile = path.join(directory, "parent.jsonl");
      fs.writeFileSync(sessionFile, [
        { type: "session", version: 3, id: randomUUID(), timestamp: new Date().toISOString(), cwd: directory },
        { type: "message", id: "seed-user", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: "Remember the parent fixture conversation.", timestamp: Date.now() } },
      ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
      owner = await host.start({ kind: "pi", name: `fork-owner-${randomUUID().slice(0, 8)}`, cwd: directory, sessionFile,
        args: ["--no-skills", "--no-prompt-templates", "--no-context-files", "--provider", "orchestration-fixture", "--model", "two", "--thinking", "low"],
        env: { PI_CODING_AGENT_DIR: agentDirectory, PI_NESTED: "0", PI_ORCHESTRATION_HOST: kind, PI_ORCHESTRATION_ENDPOINT: endpoint }, placement: "worker", parent });
      if (kind === "herdr") {
        const value = JSON.parse((await exec(process.env.HERDR_BIN_PATH || "herdr", ["pane", "get", owner.paneId!])).stdout) as { result: { pane: { tab_id: string } } };
        ownedHerdrTab = value.result.pane.tab_id;
      }
      await until(() => reports().some((event) => event.event === "startup" && event.session === sessionFile), "isolated parent startup");
      const startup = reports().find((event) => event.event === "startup" && event.session === sessionFile)!;
      assert.ok(startup.commands.includes("fork-here"));
      assert.equal(startup.provider, "orchestration-fixture");
      const draft = "unsent parent draft — never submit this";
      if (kind === "emacs") await input(owner, draft);
      else await host.send(owner, { kind: "text", text: draft, enter: false });
      await host.send(owner, { kind: "prompt", text: "/lifecycle-report" });
      await until(() => reports().some((event) => event.event === "report" && event.session === sessionFile), "parent report");
      const before = reports().findLast((event) => event.event === "report" && event.session === sessionFile)!;
      const bytes = fs.readFileSync(sessionFile, "utf8");

      await host.send(owner, { kind: "prompt", text: `/fork-here ${names[0]}` });
      await until(() => readTarget(names[0]) !== undefined, "public idle fork creation");
      const idle = readTarget(names[0])!;
      // Do not submit a prompted fork unless its isolated sibling proved the faux
      // fixture was discovered. This guard prevents accidental real-provider calls.
      await until(() => reports().some((event) => event.event === "startup" && event.session === idle.sessionFile), "idle fork inherits faux-only settings");
      // session_start hooks are ordered: the fixture may load before /tools.
      // Query only after native readiness, once all startup hooks have finished.
      await host.send(idle, { kind: "prompt", text: "/lifecycle-report" });
      await until(() => reports().some((event) => event.event === "report" && event.session === idle.sessionFile), "idle child report after startup hooks");
      const childStartup = reports().find((event) => event.event === "report" && event.session === idle.sessionFile)!;
      assert.equal(childStartup.provider, before.provider);
      assert.equal(childStartup.model, before.model);
      assert.equal(childStartup.thinking, before.thinking);
      assert.deepEqual(childStartup.tools, before.tools);
      assert.equal(childStartup.idle, true);
      assert.equal(reports().some((event) => event.event === "request" && event.session === idle.sessionFile), false);
      assert.notEqual(idle.id, owner.id);
      assert.equal(idle.host, kind);
      assert.equal(idle.endpoint, endpoint);
      if (kind === "tmux") {
        const window = async (target: HostTarget) => (await exec("tmux", ["-S", endpoint, "display-message", "-p", "-t", target.id, "#{window_id}"])).stdout.trim();
        assert.equal(await window(idle), await window(owner));
      } else if (kind === "herdr") {
        const tab = async (target: HostTarget) => {
          const value = JSON.parse((await exec(process.env.HERDR_BIN_PATH || "herdr", ["pane", "get", target.paneId!])).stdout) as { result: { pane: { tab_id: string } } };
          return value.result.pane.tab_id;
        };
        assert.equal(await tab(idle), await tab(owner));
      }
      await host.send(owner, { kind: "prompt", text: `/fork-here ${names[1]} -- native fork discussion` });
      await until(() => readTarget(names[1]) !== undefined, "public prompted fork creation");
      const prompted = readTarget(names[1])!;
      await until(() => reports().some((event) => event.event === "request" && event.session === prompted.sessionFile && event.prompt === "native fork discussion"), "prompted fork uses faux model");
      const reportCount = reports().filter((event) => event.event === "report" && event.session === sessionFile).length;
      await host.send(owner, { kind: "prompt", text: "/lifecycle-report" });
      await until(() => reports().filter((event) => event.event === "report" && event.session === sessionFile).length > reportCount, "parent unchanged after forks");
      const after = reports().findLast((event) => event.event === "report" && event.session === sessionFile)!;
      assert.equal(after.leaf, before.leaf);
      assert.equal(fs.readFileSync(sessionFile, "utf8"), bytes);
      assert.equal(kind === "emacs" ? await input(owner) : after.draft, draft);
      t.diagnostic("Passed actual /fork-here idle and prompted paths: explicit sibling identity, isolated faux provider, model/thinking/tools, unchanged parent session/leaf/draft.");
    } catch (error) {
      t.diagnostic(`Fork trace: ${JSON.stringify(reports())}`);
      if (host && owner) t.diagnostic(`Parent output: ${await host.read(owner, 80).catch(String)}`);
      throw error;
    } finally {
      if (host) {
        for (const name of names) {
          const target = readTarget(name);
          if (target) { await host.close(target); removeTarget(name); }
        }
        if (ownedHerdrTab) await exec(process.env.HERDR_BIN_PATH || "herdr", ["tab", "close", ownedHerdrTab]);
        else if (owner) await host.close(owner);
      }
      if (server && kind === "tmux") await exec("tmux", ["-S", endpoint, "kill-server"]);
      if (server && kind === "emacs") await exec("emacsclient", ["--socket-name", endpoint, "--eval", "(kill-emacs)"]);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}
