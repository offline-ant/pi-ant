import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import { fauxAssistantMessage, fauxProvider, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices,
  initTheme, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession, type AgentSessionRuntime, type CreateAgentSessionRuntimeFactory,
  type ExtensionAPI, type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { TOOL_SELECTION_ENTRY } from "../extensions/tool-selection.ts";
import { registerSwitch } from "./extensions/switch.ts";
import type { SwitchSource } from "./switch-destinations.ts";
import type { HostTarget } from "./host-types.ts";

initTheme("dark");

interface FixtureOptions {
  start?: (source: SwitchSource) => Promise<string>;
  cancelReplacement?: boolean;
  targets?: HostTarget[];
}

/** Real runtime replacement and lifecycle; only destination transport is injected. */
async function fixture(t: TestContext, options: FixtureOptions = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-switch-sdk-"));
  const agentDir = path.join(directory, "agent");
  const sessionDir = path.join(agentDir, "sessions", "fixture");
  fs.mkdirSync(sessionDir, { recursive: true });
  const provider = fauxProvider({
    provider: "switch-sdk-fixture", models: [{ id: "one", reasoning: true }], tokensPerSecond: 1_000_000,
  });
  let inferenceCalls = 0;
  provider.setResponses(Array.from({ length: 8 }, () => () => {
    inferenceCalls++;
    return fauxAssistantMessage("faux answer");
  }));
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsPath: null,
    modelsStorePath: path.join(agentDir, "models-store.json"), allowModelNetwork: false,
  });
  const settingsManager = SettingsManager.inMemory({
    defaultProvider: provider.provider.id, defaultModel: "one",
    compaction: { enabled: false }, retry: { enabled: false },
  });
  const trace: Array<{ event: string; file?: string }> = [];
  const notices: string[] = [];
  const errors: string[] = [];
  const apis: ExtensionAPI[] = [];
  const prepared: SwitchSource[] = [];
  const launched: SwitchSource[] = [];
  const stopped: string[] = [];
  let original: string | undefined;
  let releasedBytes: string | undefined;
  let runtime: AgentSessionRuntime;
  const extension: ExtensionFactory = (pi) => {
    apis.push(pi);
    pi.registerProvider(provider.provider);
    pi.on("session_start", (_event, ctx) => {
      trace.push({ event: "session_start", file: ctx.sessionManager.getSessionFile() });
    });
    pi.on("session_before_switch", () => options.cancelReplacement ? { cancel: true } : undefined);
    pi.on("session_shutdown", (_event, ctx) => {
      const file = ctx.sessionManager.getSessionFile();
      trace.push({ event: "session_shutdown", file });
      if (file && file === original) {
        releasedBytes = fs.readFileSync(file, "utf8");
      }
    });
    registerSwitch(pi, {
      environment: () => ({
        HOME: directory, PI_CODING_AGENT_DIR: agentDir,
        HERDR_ENV: "1", HERDR_SOCKET_PATH: path.join(directory, "herdr.sock"),
        HERDR_PANE_ID: "source:p1", HERDR_WORKSPACE_ID: "source", PI_NESTED: "0",
      }),
      targets: () => options.targets ?? [],
      prepare: async (_kind: "herdr" | "tau", source: SwitchSource) => {
        prepared.push(source);
        trace.push({ event: "prepare", file: runtime.session.sessionFile });
        return { start: async () => {
          launched.push(source);
          trace.push({ event: "launch", file: runtime.session.sessionFile });
          assert.equal(runtime.session.sessionFile, original, "replacement retains the conversation file");
          assert.ok(releasedBytes, "outgoing shutdown handlers must finish before launch");
          assert.equal(fs.readFileSync(source.sessionFile, "utf8"), releasedBytes);
          assert.throws(() => apis[0]!.getActiveTools(), /stale/, "the outgoing extension API really is invalid");
          return options.start ? options.start(source) : "Tau fixture destination";
        } };
      },
    });
  };
  const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
    const services = await createAgentSessionServices({
      cwd, agentDir, modelRuntime, settingsManager,
      resourceLoaderOptions: {
        noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true,
        extensionFactories: [extension],
      },
    });
    const created = await createAgentSessionFromServices({
      services, sessionManager, sessionStartEvent,
      model: sessionManager.getEntries().length === 0 ? provider.getModel() : undefined,
      tools: ["read", "bash"],
    });
    assert.deepEqual(created.extensionsResult.errors, []);
    assert.deepEqual(services.diagnostics.filter((item) => item.type === "error"), []);
    return { ...created, services, diagnostics: services.diagnostics };
  };
  runtime = await createAgentSessionRuntime(createRuntime, {
    cwd: directory, agentDir, sessionManager: SessionManager.create(directory, sessionDir),
  });
  async function bind(session: AgentSession): Promise<void> {
    const baseUi = session.extensionRunner.createContext().ui;
    await session.bindExtensions({
      mode: "rpc",
      uiContext: { ...baseUi, notify: (message) => { notices.push(message); } },
      shutdownHandler: () => { stopped.push(session.sessionFile!); },
      onError: (error) => { errors.push(error.error); },
      commandContextActions: {
        waitForIdle: () => runtime.session.waitForIdle(),
        newSession: (opts) => runtime.newSession(opts),
        switchSession: (file, opts) => runtime.switchSession(file, opts),
        fork: (id, opts) => runtime.fork(id, opts),
        navigateTree: async () => ({ cancelled: true }),
        reload: () => runtime.session.reload(),
      },
    });
  }
  runtime.setRebindSession(bind);
  await bind(runtime.session);
  await modelRuntime.setRuntimeApiKey(provider.provider.id, "fixture-key");
  await modelRuntime.getAvailable();
  await runtime.session.prompt("persist the original conversation");
  original = runtime.session.sessionFile!;
  assert.ok(fs.existsSync(original));
  const originalId = runtime.session.sessionId;
  t.after(async () => {
    await runtime.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
    assert.deepEqual(errors, [], "replacement must not leak stale-context or callback errors to Pi");
  });
  return {
    runtime, directory, agentDir, original, originalId, trace, notices, errors, prepared, launched, stopped,
    inferenceCalls: () => inferenceCalls,
    releasedBytes: () => releasedBytes,
    createRuntime,
  };
}

test("switch releases the real SDK runtime before launching and preserves the same session, selected branch, tools and model", async (t) => {
  const f = await fixture(t);
  const source = f.runtime.session;
  source.setThinkingLevel("high");
  source.setActiveToolsByName(["read"]);
  const selectedLeaf = source.sessionManager.getLeafId()!;
  await source.prompt("abandoned branch must not become active on transfer");
  source.sessionManager.branch(selectedLeaf);
  source.refreshContext();
  const requests = f.inferenceCalls();
  await source.prompt("/switch tau");

  assert.equal(f.prepared.length, 1);
  assert.equal(f.launched.length, 1);
  assert.equal(f.inferenceCalls(), requests, "switch never submits a model prompt");
  assert.equal(f.prepared[0]!.sessionFile, f.original);
  assert.equal(f.prepared[0]!.cwd, f.directory);
  assert.deepEqual(f.prepared[0]!.args, ["--provider", "switch-sdk-fixture", "--model", "one", "--thinking", "high"]);
  assert.equal(f.prepared[0]!.env.PI_CODING_AGENT_DIR, f.agentDir);
  const phases = f.trace.map((item) => item.event);
  assert.ok(phases.indexOf("prepare") < phases.indexOf("session_shutdown"));
  assert.ok(phases.indexOf("session_shutdown") < phases.indexOf("launch"));
  assert.deepEqual(f.stopped, [], "source process stays open");
  assert.equal(f.runtime.session.sessionFile, f.original);
  assert.equal(f.runtime.session.sessionId, f.originalId);
  assert.notEqual(f.runtime.session, source, "same-file replacement releases the old provider runtime");
  assert.ok(JSON.stringify(f.runtime.session.messages).includes("persist the original conversation"));
  assert.ok(f.notices.some((notice) => notice.includes("/resume")));

  const resumed = SessionManager.open(f.original);
  assert.equal(resumed.getSessionId(), f.originalId);
  assert.equal(resumed.getCwd(), f.directory);
  const branch = resumed.getBranch();
  assert.ok(branch.some((entry) => entry.id === selectedLeaf));
  assert.ok(!JSON.stringify(branch).includes("abandoned branch must not become active"));
  assert.ok(JSON.stringify(resumed.getEntries()).includes("abandoned branch must not become active"), "the rest of the tree remains intact");
  const tools = branch.findLast((entry) => entry.type === "custom" && entry.customType === TOOL_SELECTION_ENTRY);
  assert.ok(tools?.type === "custom");
  assert.deepEqual(tools.data, { enabledTools: ["read"] });
  assert.equal(branch.at(-1)?.id, tools.id, "selection is the latest branch entry in both frontends");

  const destination = await f.createRuntime({ cwd: f.directory, agentDir: f.agentDir, sessionManager: resumed });
  try {
    assert.equal(destination.session.model?.provider, "switch-sdk-fixture");
    assert.equal(destination.session.model?.id, "one");
    assert.equal(destination.session.thinkingLevel, "high");
    assert.equal(destination.session.sessionId, f.originalId);
    assert.equal(fs.readFileSync(f.original, "utf8"), f.releasedBytes());
  } finally { destination.session.dispose(); }
  assert.equal(fs.readFileSync(f.original, "utf8"), f.releasedBytes(), "destination inspection never writes to the transferred file");
});

test("a failed destination leaves the source conversation open without another replacement", async (t) => {
  const f = await fixture(t, { start: async () => { throw new Error("destination did not start"); } });
  await f.runtime.session.prompt("/switch tau");
  assert.equal(f.launched.length, 1);
  assert.equal(f.runtime.session.sessionFile, f.original);
  assert.equal(f.runtime.session.sessionId, f.originalId);
  assert.equal(f.stopped.length, 0);
  assert.equal(f.trace.filter((item) => item.event === "session_start").length, 2, "only the original and refreshed source runtimes start");
  assert.ok(f.notices.some((text) => /destination did not start/.test(text)));
  assert.equal(f.inferenceCalls(), 1);
});

test("native same-file resume reads multiple destination turns and the next source turn extends that latest branch", async (t) => {
  const f = await fixture(t);
  await f.runtime.session.prompt("/switch tau");
  const beforeDestination = f.runtime.session.sessionManager.getLeafId();
  const destination = await f.createRuntime({
    cwd: f.directory, agentDir: f.agentDir, sessionManager: SessionManager.open(f.original),
  });
  try {
    for (const message of ["Tau turn one", "Tau turn two", "Tau turn three"]) await destination.session.prompt(message);
    const destinationLeaf = destination.session.sessionManager.getLeafId()!;
    const bytes = fs.readFileSync(f.original, "utf8");
    assert.notEqual(destinationLeaf, beforeDestination);
    assert.equal(f.runtime.session.sessionManager.getLeafId(), beforeDestination, "old views do not live-sync");

    // TUI /resume and RPC switch_session both call this native runtime API,
    // including when the selected session file is already open here.
    assert.deepEqual(await f.runtime.switchSession(f.original), { cancelled: false });
    assert.equal(f.runtime.session.sessionId, f.originalId);
    assert.equal(f.runtime.session.sessionManager.getLeafId(), destinationLeaf);
    assert.equal(fs.readFileSync(f.original, "utf8"), bytes, "resume never rewrites the old view to disk");
    for (const text of ["Tau turn one", "Tau turn two", "Tau turn three"]) {
      assert.ok(JSON.stringify(f.runtime.session.messages).includes(text));
    }
    await f.runtime.session.prompt("continue here after Tau");
    const branch = SessionManager.open(f.original).getBranch();
    const continuation = branch.find((entry) => entry.type === "message" && entry.message.role === "user"
      && JSON.stringify(entry.message.content).includes("continue here after Tau"));
    assert.ok(continuation);
    assert.equal(continuation.parentId, destinationLeaf, "next turn extends Tau's latest leaf, not the original stale branch");
    assert.deepEqual(f.stopped, []);
    assert.equal(f.inferenceCalls(), 5);
  } finally { destination.session.dispose(); }
});

test("cancelling native session replacement never starts a destination or shuts down the source", async (t) => {
  const f = await fixture(t, { cancelReplacement: true });
  await f.runtime.session.prompt("/switch tau");
  assert.equal(f.prepared.length, 1);
  assert.equal(f.launched.length, 0);
  assert.equal(f.stopped.length, 0);
  assert.equal(f.runtime.session.sessionFile, f.original);
  assert.equal(f.trace.some((entry) => entry.event === "session_shutdown"), false);
  assert.equal(f.inferenceCalls(), 1);
});

test("registry-owned sessions are refused before preflight or replacement", async (t) => {
  const targets: HostTarget[] = [];
  const f = await fixture(t, { targets });
  targets.push({ host: "herdr", endpoint: "/fixture/socket", id: "worker", kind: "pi", name: "worker", sessionFile: f.original });
  const before = fs.readFileSync(f.original, "utf8");
  await f.runtime.session.prompt("/switch tau");
  assert.equal(f.prepared.length, 0);
  assert.equal(f.launched.length, 0);
  assert.equal(f.runtime.session.sessionFile, f.original);
  assert.equal(fs.readFileSync(f.original, "utf8"), before);
  assert.equal(f.inferenceCalls(), 1);
});
