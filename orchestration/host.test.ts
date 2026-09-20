import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test, { after, before } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { availableHosts, getHost, getHostState, hostForTarget, selectHost, setHostOverride } from "./host.ts";
import type { HostKind, HostTarget, StartSpec } from "./host-types.ts";
import { initializeNesting } from "./nesting.ts";

const inheritedNesting = process.env.PI_NESTED;
before(() => { process.env.PI_NESTED = "0"; });
after(() => {
  if (inheritedNesting === undefined) delete process.env.PI_NESTED;
  else process.env.PI_NESTED = inheritedNesting;
});

/** A tau server publishes its endpoint under the agent directory while it runs. */
function publishTauServer(endpoint: string, pid = process.pid): { home: string; agentDir: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-host-"));
  const agentDir = path.join(home, ".pi", "agent");
  fs.mkdirSync(path.join(agentDir, "tau"), { recursive: true });
  fs.writeFileSync(path.join(agentDir, "tau", "server.json"), JSON.stringify({ endpoint, pid, startedAt: new Date().toISOString() }));
  return { home, agentDir };
}

test("host selection rejects ambiguous native environments and missing endpoints", () => {
  assert.throws(() => selectHost({}), /needs tmux, Herdr, Pilish, or a tau server/);
  assert.throws(() => selectHost({ HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/h", TMUX: "/tmp/t,1,0" }), /Several orchestration hosts are present \(tmux, herdr\)/);
  assert.throws(() => selectHost({ PI_ORCHESTRATION_HOST: "emacs" }), /No emacs endpoint/);
  assert.throws(() => selectHost({ PI_ORCHESTRATION_HOST: "unknown" }), /PI_ORCHESTRATION_HOST must be one of tmux, herdr, emacs, web/);
  assert.deepEqual(selectHost({ HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/h" }), { kind: "herdr", endpoint: "/tmp/h" });
  assert.deepEqual(selectHost({ TMUX: "/tmp/t,1,0" }), { kind: "tmux", endpoint: "/tmp/t" });
  assert.deepEqual(selectHost({ PI_ORCHESTRATION_HOST: "tmux", HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/h", TMUX: "/tmp/t,1,0" }), { kind: "tmux", endpoint: "/tmp/t" });
  assert.deepEqual(selectHost({ PI_ORCHESTRATION_HOST: "emacs", PI_ORCHESTRATION_ENDPOINT: "/tmp/e" }), { kind: "emacs", endpoint: "/tmp/e" });
});

test("the explicit endpoint belongs to the explicit host; other reachable hosts keep their native endpoints", () => {
  const env = { PI_ORCHESTRATION_HOST: "emacs", PI_ORCHESTRATION_ENDPOINT: "/tmp/e", HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/h", TMUX: "/tmp/t,1,0" };
  assert.deepEqual(availableHosts(env), [
    { kind: "tmux", endpoint: "/tmp/t" }, { kind: "herdr", endpoint: "/tmp/h" }, { kind: "emacs", endpoint: "/tmp/e" },
  ]);
  assert.deepEqual(selectHost(env), { kind: "emacs", endpoint: "/tmp/e" });
  assert.deepEqual(availableHosts({ PI_ORCHESTRATION_HOST: "herdr", PI_ORCHESTRATION_ENDPOINT: "/tmp/pinned", HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/h" }),
    [{ kind: "herdr", endpoint: "/tmp/pinned" }]);
  assert.deepEqual(availableHosts({ PI_ORCHESTRATION_ENDPOINT: "/tmp/orphan" }), []);
});

test("a published tau server is reachable, but only hosts sessions that have no terminal or ask for it", () => {
  const { home, agentDir } = publishTauServer("http://rs:l@127.0.0.1:3001");
  const web = { kind: "web", endpoint: "http://rs:l@127.0.0.1:3001" };
  assert.deepEqual(availableHosts({ PI_CODING_AGENT_DIR: agentDir }), [web]);
  assert.deepEqual(availableHosts({ HOME: home }), [web]);
  // A terminal session keeps its terminal; the server stays available for an
  // explicit selection instead of silently taking over.
  assert.deepEqual(availableHosts({ PI_CODING_AGENT_DIR: agentDir, TMUX: "/tmp/t,1,0" }), [{ kind: "tmux", endpoint: "/tmp/t" }, web]);
  assert.deepEqual(selectHost({ PI_CODING_AGENT_DIR: agentDir, TMUX: "/tmp/t,1,0" }), { kind: "tmux", endpoint: "/tmp/t" });
  assert.deepEqual(selectHost({ PI_CODING_AGENT_DIR: agentDir }), web);
  assert.deepEqual(selectHost({ PI_CODING_AGENT_DIR: agentDir, PI_ORCHESTRATION_HOST: "web" }), web);
  // Tau tells its own children where it lives, like any other host.
  assert.deepEqual(selectHost({ PI_ORCHESTRATION_HOST: "web", PI_ORCHESTRATION_ENDPOINT: "http://127.0.0.1:3100" }),
    { kind: "web", endpoint: "http://127.0.0.1:3100" });
  // Discovery needs a home to look in, and a dead server is not a host.
  assert.deepEqual(availableHosts({}), []);
  const stale = publishTauServer("http://127.0.0.1:3001", 0x7fffffff);
  assert.deepEqual(availableHosts({ PI_CODING_AGENT_DIR: stale.agentDir }), []);
});

test("selection is frozen per process; overrides choose among reachable hosts; stored targets retain their original host", () => {
  const keys = ["PI_ORCHESTRATION_HOST", "PI_ORCHESTRATION_ENDPOINT", "HERDR_ENV", "HERDR_SOCKET_PATH", "TMUX"];
  const previous = keys.map((key) => process.env[key]);
  const pi = {} as ExtensionAPI;
  try {
    process.env.PI_ORCHESTRATION_HOST = "emacs";
    process.env.PI_ORCHESTRATION_ENDPOINT = "/tmp/original";
    process.env.HERDR_ENV = "1";
    process.env.HERDR_SOCKET_PATH = "/tmp/herdr";
    delete process.env.TMUX;
    assert.equal(getHost(pi).kind, "emacs");
    process.env.PI_ORCHESTRATION_HOST = "tmux";
    process.env.PI_ORCHESTRATION_ENDPOINT = "/tmp/new";
    process.env.HERDR_SOCKET_PATH = "/tmp/other";
    assert.equal(getHost(pi).endpoint, "/tmp/original");
    assert.equal(getHost(pi).kind, "emacs");

    setHostOverride("herdr");
    assert.equal(getHost(pi).kind, "herdr");
    assert.equal(getHost(pi).endpoint, "/tmp/herdr", "an override never reuses the environment host's endpoint");
    assert.deepEqual(getHostState().configured, { kind: "emacs", endpoint: "/tmp/original" });
    setHostOverride("tmux");
    assert.equal(getHostState().effective, undefined);
    assert.throws(() => getHost(pi), /'tmux' is not reachable.*reachable: herdr, emacs/);
    setHostOverride(null);
    assert.equal(getHost(pi).kind, "emacs");

    const pinned = hostForTarget(pi, { host: "tmux", endpoint: "/tmp/stored", id: "%1", name: "stored", kind: "pi" });
    assert.equal(pinned.kind, "tmux");
    assert.equal(pinned.endpoint, "/tmp/stored");
  } finally {
    setHostOverride(null);
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index];
    });
  }
});

test("Pi startup is serialized across extension APIs; cancelled queued work never starts", async () => {
  let release!: () => void;
  const firstStartup = new Promise<void>((resolve) => { release = resolve; });
  const started: string[] = [];
  const targets = new Map<string, HostTarget>();
  const pi = {
    exec: async (_command: string, args: string[]) => {
      const encoded = /pi-orchestration-dispatch "([^"]+)"/.exec(args.at(-1)!)?.[1];
      assert.ok(encoded);
      const data = JSON.parse(Buffer.from(encoded, "base64").toString()) as { operation: string; id: string; spec?: StartSpec };
      let reply: unknown;
      if (data.operation === "start") {
        assert.ok(data.spec);
        started.push(data.spec.name);
        const target: HostTarget = { host: "emacs", endpoint: "/tmp/emacs", id: data.id, name: data.spec.name, kind: "pi" };
        targets.set(data.id, target);
        if (started.length === 1) await firstStartup;
        reply = { target };
      } else if (data.operation === "state") {
        reply = { ready: true, state: "running" };
      } else {
        reply = { success: true };
      }
      return { code: 0, stderr: "", killed: false, stdout: JSON.stringify(Buffer.from(JSON.stringify(reply)).toString("base64")) };
    },
  } as unknown as ExtensionAPI;
  const target: HostTarget = { host: "emacs", endpoint: "/tmp/emacs", id: "parent", name: "parent", kind: "pi" };
  const firstHost = hostForTarget(pi, target);
  const secondHost = hostForTarget({ ...pi } as ExtensionAPI, target);
  const spec: StartSpec = { kind: "pi", cwd: "/tmp", name: "first", sessionFile: "/tmp/session", args: [], placement: "worker", parent: target };
  const first = firstHost.start(spec);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const cancel = new AbortController();
  const cancelled = secondHost.start({ ...spec, name: "cancelled" }, cancel.signal);
  const second = secondHost.start({ ...spec, name: "second" });
  cancel.abort();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ["first"]);
  release();
  await assert.rejects(cancelled);
  await Promise.all([first, second]);
  assert.deepEqual(started, ["first", "second"]);
});

test("all hosts receive the parent's activated depth and pinned selection before native startup", async () => {
  const depthKey = Symbol.for("pi-orchestration:nesting-depth");
  const globals = globalThis as typeof globalThis & { [depthKey]?: number };
  const savedDepth = globals[depthKey];
  const savedEnv = process.env.PI_NESTED;
  const savedAgentDirectory = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = "/tmp/parent-agent-directory";
  delete globals[depthKey];
  process.env.PI_NESTED = "1";
  initializeNesting();
  try {
    for (const kind of ["tmux", "herdr", "emacs"] as const) {
      const endpoint = `/tmp/depth-${kind}`;
      let checkedEnvironment = false;
      const pi = {
        exec: async (_command: string, args: string[]) => {
          if (kind === "tmux" && args.includes("display-message")) {
            return { code: 0, stdout: "$1\n", stderr: "", killed: false };
          }
          if (kind === "herdr" && args.includes("get")) {
            return { code: 0, stdout: JSON.stringify({ result: { pane: { workspace_id: "workspace" } } }), stderr: "", killed: false };
          }
          if (kind === "emacs") {
            const encoded = /pi-orchestration-dispatch "([^"]+)"/.exec(args.at(-1)!)?.[1];
            assert.ok(encoded);
            const data = JSON.parse(Buffer.from(encoded, "base64").toString()) as { operation: string; spec?: StartSpec };
            if (data.operation === "close") return { code: 0, stdout: JSON.stringify(Buffer.from('{"success":true}').toString("base64")), stderr: "", killed: false };
            assert.equal(data.spec?.env?.PI_NESTED, "2");
            assert.equal(data.spec?.env?.PI_ORCHESTRATION_HOST, kind);
            assert.equal(data.spec?.env?.PI_ORCHESTRATION_ENDPOINT, endpoint);
            assert.equal(data.spec?.env?.CUSTOM, "preserved");
            assert.equal(data.spec?.env?.PI_CODING_AGENT_DIR, "/tmp/parent-agent-directory");
          } else {
            for (const entry of ["PI_NESTED=2", `PI_ORCHESTRATION_HOST=${kind}`, `PI_ORCHESTRATION_ENDPOINT=${endpoint}`, "CUSTOM=preserved", "PI_CODING_AGENT_DIR=/tmp/parent-agent-directory"]) {
              assert.ok(args.includes(entry), `Missing ${entry}: ${JSON.stringify(args)}`);
            }
          }
          checkedEnvironment = true;
          throw new Error("fake native creation stopped");
        },
      } as unknown as ExtensionAPI;
      const parent: HostTarget = { host: kind, endpoint, id: "parent", kind: "pi", name: "parent" };
      await assert.rejects(hostForTarget(pi, parent).start({
        kind: "pi", name: "child", cwd: "/tmp", sessionFile: "/tmp/not-started", args: [], placement: "worker", parent,
        env: { CUSTOM: "preserved", PI_NESTED: "99", PI_ORCHESTRATION_HOST: "wrong", PI_ORCHESTRATION_ENDPOINT: "wrong" },
      }), /fake native creation stopped/);
      assert.equal(checkedEnvironment, true, kind);
    }
  } finally {
    if (savedDepth === undefined) delete globals[depthKey]; else globals[depthKey] = savedDepth;
    if (savedEnv === undefined) delete process.env.PI_NESTED; else process.env.PI_NESTED = savedEnv;
    if (savedAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = savedAgentDirectory;
  }
});

test("depth-limit Pi starts reject before any host operation; shell panels still work", async () => {
  const depthKey = Symbol.for("pi-orchestration:nesting-depth");
  const globals = globalThis as typeof globalThis & { [depthKey]?: number };
  const savedDepth = globals[depthKey];
  globals[depthKey] = 3;
  try {
    for (const kind of ["tmux", "herdr", "emacs"] satisfies HostKind[]) {
      let calls = 0;
      const pi = { exec: async () => { calls++; throw new Error("shell reached native host"); } } as unknown as ExtensionAPI;
      const parent: HostTarget = { host: kind, endpoint: "/tmp/limit", id: "parent", kind: "pi", name: "parent" };
      const host = hostForTarget(pi, parent);
      await assert.rejects(host.start({ kind: "pi", name: "too-deep", cwd: "/tmp", sessionFile: "/tmp/not-started", args: [], placement: "worker", parent }), /nested too deep/);
      assert.equal(calls, 0, kind);
      await assert.rejects(host.start({ kind: "shell", name: "shell", cwd: "/tmp", command: "true", placement: "worker", parent }), /shell reached native host/);
      assert.ok(calls > 0);
    }
  } finally {
    if (savedDepth === undefined) delete globals[depthKey]; else globals[depthKey] = savedDepth;
  }
});
