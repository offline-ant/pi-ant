import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getHost, hostForTarget, selectHost } from "./host.ts";
import type { HostKind, HostTarget, StartSpec } from "./host-types.ts";
import { initializeNesting } from "./nesting.ts";

const inheritedNesting = process.env.PI_NESTED;
before(() => { process.env.PI_NESTED = "0"; });
after(() => {
  if (inheritedNesting === undefined) delete process.env.PI_NESTED;
  else process.env.PI_NESTED = inheritedNesting;
});

test("host selection rejects ambiguous native environments and missing endpoints", () => {
  assert.throws(() => selectHost({}), /needs tmux, Herdr, or Pilish/);
  assert.throws(() => selectHost({ HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/h", TMUX: "/tmp/t,1,0" }), /Both Herdr and tmux/);
  assert.throws(() => selectHost({ PI_ORCHESTRATION_HOST: "emacs" }), /No emacs endpoint/);
  assert.throws(() => selectHost({ PI_ORCHESTRATION_HOST: "unknown" }), /needs tmux, Herdr, or Pilish/);
  assert.deepEqual(selectHost({ HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/h" }), { kind: "herdr", endpoint: "/tmp/h" });
  assert.deepEqual(selectHost({ TMUX: "/tmp/t,1,0" }), { kind: "tmux", endpoint: "/tmp/t" });
  assert.deepEqual(selectHost({ PI_ORCHESTRATION_HOST: "tmux", HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/h", TMUX: "/tmp/t,1,0" }), { kind: "tmux", endpoint: "/tmp/t" });
  assert.deepEqual(selectHost({ PI_ORCHESTRATION_HOST: "emacs", PI_ORCHESTRATION_ENDPOINT: "/tmp/e" }), { kind: "emacs", endpoint: "/tmp/e" });
});

test("selection is frozen per process; stored targets retain their original host", () => {
  const previousHost = process.env.PI_ORCHESTRATION_HOST;
  const previousEndpoint = process.env.PI_ORCHESTRATION_ENDPOINT;
  const pi = {} as ExtensionAPI;
  try {
    process.env.PI_ORCHESTRATION_HOST = "herdr";
    process.env.PI_ORCHESTRATION_ENDPOINT = "/tmp/original";
    assert.equal(getHost(pi).kind, "herdr");
    process.env.PI_ORCHESTRATION_HOST = "tmux";
    process.env.PI_ORCHESTRATION_ENDPOINT = "/tmp/new";
    assert.equal(getHost(pi).endpoint, "/tmp/original");
    assert.equal(getHost(pi).kind, "herdr");
    const pinned = hostForTarget(pi, { host: "tmux", endpoint: "/tmp/stored", id: "%1", name: "stored", kind: "pi" });
    assert.equal(pinned.kind, "tmux");
    assert.equal(pinned.endpoint, "/tmp/stored");
  } finally {
    if (previousHost === undefined) delete process.env.PI_ORCHESTRATION_HOST; else process.env.PI_ORCHESTRATION_HOST = previousHost;
    if (previousEndpoint === undefined) delete process.env.PI_ORCHESTRATION_ENDPOINT; else process.env.PI_ORCHESTRATION_ENDPOINT = previousEndpoint;
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
