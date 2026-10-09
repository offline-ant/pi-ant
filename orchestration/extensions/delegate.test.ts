import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import test, { type TestContext } from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentTools, InMemoryCredentialStore, type JsonObject, type Tool } from "@earendil-works/pi-ai";
import { createAgentSession, createCodemodeExtension, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type AgentSession, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { EphemeralWorkerTool } from "../delegate-policy.ts";
import type { WorkerRequestFile } from "../worker-frame.ts";
import { workerResumeCommand } from "../worker-resume.ts";
import delegateExtension, { type DelegateParams } from "./delegate.ts";

const toolNames = ["do", "delegate", "fresh_look"] as const;
interface Launch { args: string[]; sessionFile: string }

function hasAlt(tool: Tool): boolean {
  const schema = tool.parameters as { properties: Record<string, unknown> };
  return Object.hasOwn(schema.properties, "alt");
}

/** Real Pi SDK, registrations and worker protocol; no browser process or paid inference. */
async function fixture(t: TestContext, codemodeOnly = false) {
  // Each fixture represents a new Pi process; host selection is process-pinned.
  const hostStateKey = Symbol.for("pi-ant.orchestration.host");
  const globals = globalThis as typeof globalThis & { [hostStateKey]?: unknown };
  const previousHostState = globals[hostStateKey];
  delete globals[hostStateKey];
  t.after(() => {
    if (previousHostState === undefined) delete globals[hostStateKey];
    else globals[hostStateKey] = previousHostState;
  });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-delegate-sdk-"));
  const agentDir = path.join(directory, "agent");
  const config = path.join(agentDir, "delegate-alt.json");
  const keys = ["PI_CODING_AGENT_DIR", "PI_ORCHESTRATION_HOST", "PI_ORCHESTRATION_ENDPOINT"];
  const previous = keys.map((key) => process.env[key]);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_ORCHESTRATION_HOST = "web";
  const first = fauxProvider({ provider: "delegate-first", models: [{ id: "same-id", reasoning: true }], tokensPerSecond: 100_000 });
  const second = fauxProvider({ provider: "delegate-second", models: [{ id: "same-id", reasoning: false }], tokensPerSecond: 100_000 });
  const third = fauxProvider({ provider: "delegate-third", models: [{ id: "same-id", reasoning: true }], tokensPerSecond: 100_000 });
  const launches: Launch[] = [];
  const requests: WorkerRequestFile[] = [];
  const closed: string[] = [];
  let resolveClosure: (() => void) | undefined;
  const closure = new Promise<void>((resolve) => { resolveClosure = resolve; });
  const serverErrors: unknown[] = [];
  let failureResult: string | undefined;
  let startupError: string | undefined;
  let hold: Promise<void> | undefined;
  let release: (() => void) | undefined;
  let requestArrived: (() => void) | undefined;
  const server = http.createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks).toString();
      let result: object = {};
      if (request.method === "POST" && request.url === "/api/live-sessions") {
        launches.push(JSON.parse(raw) as Launch);
        if (startupError) {
          response.writeHead(500, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ error: startupError }));
          return;
        }
        result = { session: { id: `worker-${launches.length}` } };
      } else if (request.method === "POST" && request.url === "/api/rpc") {
        const input = JSON.parse(raw) as { message: string };
        assert.ok(input.message.startsWith("/worker-run "));
        const work = JSON.parse(fs.readFileSync(input.message.slice("/worker-run ".length), "utf8")) as WorkerRequestFile;
        requests.push(work);
        requestArrived?.();
        await hold;
        fs.writeFileSync(work.resultPath, JSON.stringify({
          id: work.id, result: failureResult ?? "fixture result", isError: failureResult !== undefined,
          retrospective: "fixture retrospective", timestamp: new Date().toISOString(),
        }));
        result = { success: true };
      } else if (request.method === "DELETE") {
        closed.push(request.url!);
        resolveClosure?.();
      } else {
        result = { entries: [] };
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(result));
    } catch (error) {
      serverErrors.push(error);
      response.writeHead(500, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: String(error) }));
    }
  });
  let session: AgentSession | undefined;
  t.after(async () => {
    release?.();
    session?.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const request of requests) fs.rmSync(path.dirname(request.resultPath), { recursive: true, force: true });
    for (const launch of launches) fs.rmSync(launch.sessionFile, { force: true });
    fs.rmSync(directory, { recursive: true, force: true });
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index];
    });
    assert.deepEqual(serverErrors, []);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  process.env.PI_ORCHESTRATION_ENDPOINT = `http://127.0.0.1:${address.port}`;
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsPath: null,
    modelsStorePath: path.join(agentDir, "models-store.json"), allowModelNetwork: false,
  });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const loader = new DefaultResourceLoader({
    cwd: directory, agentDir, settingsManager, noExtensions: true, noSkills: true,
    noContextFiles: true, noPromptTemplates: true, noThemes: true,
    extensionFactories: [createCodemodeExtension({ mode: codemodeOnly ? "only" : "on", models: false }), (pi) => {
      pi.registerProvider(first.provider);
      pi.registerProvider(second.provider);
      pi.registerProvider(third.provider);
      pi.registerTool({
        name: "self_compact", label: "Self Compact", description: "Fixture tool; never executed.",
        parameters: Type.Object({}),
        async execute() { throw new Error("Fixture self_compact must not execute"); },
      });
      pi.registerTool({
        name: "nested_worker", label: "Nested worker", description: "Fixture nested delegation.",
        parameters: Type.Object({ task: Type.String() }),
        async execute(_id, args, signal, _update, ctx) {
          const outcome = await ctx.executeTool("do", args, { signal });
          return { ...outcome.result, isError: outcome.isError };
        },
      });
      delegateExtension(pi);
    }],
  });
  await loader.reload();
  const created = await createAgentSession({
    cwd: directory, agentDir, modelRuntime, settingsManager, resourceLoader: loader,
    model: first.getModel(), thinkingLevel: "high", tools: ["read", ...toolNames, "self_compact", "codemode", "nested_worker"],
    sessionManager: SessionManager.create(directory, path.join(directory, "sessions")),
  });
  session = created.session;
  session.setActiveToolsByName(["read", ...toolNames]);
  assert.deepEqual(created.extensionsResult.errors, []);
  const errors: string[] = [];
  await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error.error) });
  await modelRuntime.setRuntimeApiKey(first.provider.id, "fixture-key");
  await modelRuntime.setRuntimeApiKey(second.provider.id, "fixture-key");
  await modelRuntime.setRuntimeApiKey(third.provider.id, "fixture-key");
  await modelRuntime.getAvailable();
  assert.ok(modelRuntime.getProvider(first.provider.id));
  assert.ok(modelRuntime.hasConfiguredAuth(first.provider.id));
  const current = session;
  const updates: Array<{ result: AgentToolResult<unknown>; launches: number }> = [];
  current.subscribe((event) => {
    if (event.type === "tool_execution_update") {
      updates.push({ result: event.partialResult, launches: launches.length });
    }
  });
  let percent = 10;
  t.mock.method(current, "getContextUsage", () => ({ tokens: percent * 1_000, contextWindow: 100_000, percent }));
  t.after(() => assert.deepEqual(errors, []));
  const definition = (name: EphemeralWorkerTool) => {
    const tool = current.getToolDefinition(name);
    assert.ok(tool, `missing ${name}`);
    return tool;
  };
  const enable = () => current.prompt("/delegate-alt delegate-first/same-id delegate-second/same-id");
  async function call(name: string, params: JsonObject) {
    const provider = [first, second, third].find((candidate) => candidate.provider.id === current.model?.provider);
    assert.ok(provider);
    provider.setResponses([
      fauxAssistantMessage(fauxToolCall(name, params), { stopReason: "toolUse" }),
      (context) => {
        const result = context.messages.findLast((message) => message.role === "toolResult");
        assert.ok(result?.role === "toolResult");
        const command = launches.at(-1) && workerResumeCommand(launches.at(-1)!.sessionFile);
        if (command && !result.isError) {
          assert.ok(!JSON.stringify(result.content).includes(command), "successful recovery metadata must not reach the model's tool content");
          assert.doesNotMatch(JSON.stringify(result.content), /To resume\/continue|enter a prompt to continue/);
        }
        return fauxAssistantMessage("parent done");
      },
    ]);
    await current.prompt(`Run the fixture ${name}.`);
    const result = current.messages.findLast((message) => message.role === "toolResult");
    assert.ok(result?.role === "toolResult", JSON.stringify(current.messages));
    return result;
  }
  async function run(name: EphemeralWorkerTool, params: DelegateParams, expectedProvider = "delegate-first", expectedThinking = "high") {
    const parent = current.model;
    const thinking = current.thinkingLevel;
    const count = requests.length;
    const result = await call(name, params);
    assert.equal(result.isError, false, JSON.stringify(result));
    assert.equal(requests.length, count + 1, JSON.stringify(result));
    const request = requests.at(-1)!;
    assert.deepEqual(request.model, { provider: expectedProvider, id: "same-id" });
    assert.equal(request.thinkingLevel, expectedThinking);
    assert.deepEqual(launches.at(-1)!.args.slice(0, 6), ["--provider", expectedProvider, "--model", "same-id", "--thinking", expectedThinking]);
    assert.ok(request.tools.includes("do"));
    assert.equal(current.model, parent);
    assert.equal(current.thinkingLevel, thinking);
    assert.match(JSON.stringify(result.content), new RegExp(`Worker model: ${expectedProvider}/same-id`));
    assert.match(JSON.stringify(result.content), /fixture result/);
    assert.match(JSON.stringify(result.content), /fixture retrospective/);
    const command = workerResumeCommand(launches.at(-1)!.sessionFile);
    assert.ok(!JSON.stringify(result.content).includes(command));
    assert.doesNotMatch(JSON.stringify(result.content), /To resume\/continue|enter a prompt to continue/);
    assert.equal((result.details as { sessionCommand: string }).sessionCommand, command);
    const persisted = SessionManager.open(current.sessionManager.getSessionFile()!).getBranch()
      .findLast((entry) => entry.type === "message" && entry.message.role === "toolResult");
    assert.ok(persisted?.type === "message" && persisted.message.role === "toolResult");
    assert.equal((persisted.message.details as { sessionCommand: string }).sessionCommand, command);
    assert.ok(!JSON.stringify(persisted.message.content).includes(command));
    for (const update of updates) {
      assert.doesNotMatch(JSON.stringify(update.result.content), /To resume\/continue|enter a prompt to continue|pi --session/);
      assert.ok((update.result.details as { sessionCommand?: string }).sessionCommand);
    }
    assert.equal(closed.length, requests.length);
    return result;
  }
  return {
    directory, config, codemodeConfig: path.join(agentDir, "codemode-delegate.json"),
    current, first, second, third, requests, launches, definition, enable, call, run, updates, closed,
    whenClosed: closure,
    failResult: (message: string) => { failureResult = message; },
    failStartup: (message: string) => { startupError = message; },
    setPercent: (value: number) => { percent = value; },
    holdNext: () => {
      hold = new Promise<void>((resolve) => { release = resolve; });
      return new Promise<void>((resolve) => { requestArrived = resolve; });
    },
    release: () => { release?.(); hold = undefined; requestArrived = undefined; },
  };
}

for (const only of [false, true]) {
  test(`codemode delegation opt-in executes with correct context (only=${only})`, { timeout: 30_000 }, async (t) => {
    const f = await fixture(t, only);
    const selected = ["read", "codemode", ...toolNames, "nested_worker"];
    f.current.setActiveToolsByName(selected);
    assert.equal(fs.existsSync(f.codemodeConfig), false);
    for (const name of toolNames) assert.equal(f.definition(name).exposure, "model-only");
    const script = (name: string) => ({ code: `return await tools.${name}({task: "Nested assignment"});` });
    const blocked = await f.call("codemode", script("do"));
    assert.match(JSON.stringify(blocked.content), /tools.do does not exist/);
    assert.equal(f.launches.length, 0);
    f.current.setActiveToolsByName(["codemode", "fresh_look"]);
    await f.current.prompt("/codemode-delegate");
    assert.deepEqual(f.current.getActiveToolNames(), ["codemode", "fresh_look"]);
    assert.ok(!f.current.getCallableToolNames().includes("do"), "toggle must not activate disabled workers");
    f.current.setActiveToolsByName(selected);
    for (const name of toolNames) assert.equal(f.definition(name).exposure, undefined);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.codemodeConfig, "utf8")), { enabled: true });
    assert.equal(fs.statSync(f.codemodeConfig).mode & 0o777, 0o600);
    assert.deepEqual(f.current.getActiveToolNames(), selected);
    await f.enable();
    for (const name of toolNames) assert.ok(hasAlt(f.definition(name)), "alternate registration composes with exposure");
    for (const name of [...toolNames, "nested_worker"]) {
      const result = await f.call("codemode", script(name));
      assert.match(JSON.stringify(result.content), /fixture result/);
      assert.match(JSON.stringify(result.content), /fixture retrospective/);
      const child = SessionManager.open(f.launches.at(-1)!.sessionFile);
      const messages = child.getBranch().flatMap((entry) => entry.type === "message" ? [entry.message] : []);
      if (name === "do" || name === "nested_worker") {
        const last = messages.at(-1);
        assert.equal(last?.role, "user", "fork is before the outer codemode assistant message");
        assert.match(JSON.stringify(last), /Run the fixture codemode/);
        assert.ok(messages.some((message) => message.role === "toolResult"), "previous conversation survives");
      } else assert.deepEqual(messages, [], "standalone workers remain blank");
    }
    const count = f.launches.length;
    const parallel = await f.call("codemode", { code: 'return await Promise.all([tools.do({task:"First"}), tools.do({task:"Second"})]);' });
    assert.match(JSON.stringify(parallel.content), /fixture result/);
    assert.equal(f.launches.length, count + 2);
    const branches = f.launches.slice(-2).map((launch) => SessionManager.open(launch.sessionFile).getBranch()
      .filter((entry) => entry.type === "message"));
    assert.deepEqual(branches[0], branches[1], "parallel workers fork from the same pre-script conversation");
    await f.current.reload();
    f.current.setActiveToolsByName(selected);
    assert.match(JSON.stringify((await f.call("codemode", script("do"))).content), /fixture result/);
    await f.current.prompt("/codemode-delegate off");
    assert.equal(fs.existsSync(f.codemodeConfig), false);
    assert.deepEqual(f.current.getActiveToolNames(), selected);
    assert.match(JSON.stringify((await f.call("codemode", script("do"))).content), /tools.do does not exist/);
    // A direct call remains available even in codemode-only mode after disabling.
    f.updates.length = 0;
    await f.run("do", { task: "Direct worker still available" });
    fs.writeFileSync(f.codemodeConfig, JSON.stringify({ enabled: true }));
    assert.match(JSON.stringify((await f.call("codemode", script("do"))).content), /fixture result/);
    fs.rmSync(f.codemodeConfig);
    assert.match(JSON.stringify((await f.call("codemode", script("do"))).content), /tools.do does not exist/);
  });
}

test("codemode cancellation reaches owned workers and retains their session files", { timeout: 30_000 }, async (t) => {
  const f = await fixture(t);
  await f.current.prompt("/codemode-delegate on");
  f.current.setActiveToolsByName(["codemode", "do"]);
  const arrived = f.holdNext();
  const pending = f.call("codemode", { code: 'return await tools.do({task:"Wait for cancellation"});' });
  await arrived;
  const file = f.launches.at(-1)!.sessionFile;
  const saved = fs.readFileSync(file, "utf8");
  await f.current.abort();
  await pending;
  // Pi may settle codemode before a nested call's asynchronous cleanup completes.
  await f.whenClosed;
  f.release();
  assert.equal(f.closed.length, 1);
  assert.equal(fs.readFileSync(file, "utf8"), saved);
});

test("nested do warning survives reload and script failures retain recovery", { timeout: 30_000 }, async (t) => {
  const f = await fixture(t);
  await f.current.prompt("/codemode-delegate on");
  f.current.setActiveToolsByName(["codemode", "do", "delegate"]);
  f.setPercent(95);
  const script = { code: 'return await tools.do({task:"Check warning"});' };
  const beforeWarning = f.current.sessionManager.getLeafId()!;
  assert.match(JSON.stringify((await f.call("codemode", script)).content), /Retry do/);
  assert.equal(f.launches.length, 0);
  await f.current.reload();
  assert.match(JSON.stringify((await f.call("codemode", script)).content), /fixture result/);
  await f.current.navigateTree(beforeWarning, { summarize: false });
  assert.match(JSON.stringify((await f.call("codemode", script)).content), /Retry do/);
  f.failStartup("nested startup rejected");
  const result = await f.call("codemode", script);
  assert.match(JSON.stringify(result.content), /nested startup rejected/);
  assert.ok(JSON.stringify(result.content).includes(workerResumeCommand(f.launches.at(-1)!.sessionFile)));
});

test("split schemas have no context flag, fresh_look is opt-in, and alternate re-registration preserves selections", { timeout: 30_000 }, async (t) => {
  const f = await fixture(t);
  const assertSchemas = (enabled: boolean) => {
    for (const name of toolNames) {
      const tool = f.definition(name);
      const schema = tool.parameters as { properties: Record<string, { default?: unknown; description?: string }>; required?: string[] };
      assert.equal(Object.hasOwn(schema.properties, "alt"), enabled);
      assert.equal(Object.hasOwn(schema.properties, "context"), false);
      assert.equal(Object.hasOwn(schema.properties, "folder"), name !== "do");
      assert.deepEqual(schema.required, ["task"]);
      assert.doesNotMatch(tool.description, /retrospective/);
      if (enabled) {
        assert.equal(schema.properties.alt.default, false);
        assert.match(tool.description, /alt=true/);
        assert.match(tool.description, /first if the caller is outside the pair/);
        assert.match(schema.properties.alt.description!, /first if the caller is outside the pair/);
        assert.match(tool.description, /delegate-first\/same-id/);
        assert.match(tool.description, /delegate-second\/same-id/);
      } else assert.doesNotMatch(JSON.stringify(tool.parameters), /alternate|\balt\b/i);
    }
  };
  assertSchemas(false);
  assert.equal(fs.existsSync(f.config), false);
  assert.deepEqual(f.current.getActiveToolNames(), ["read", "do", "delegate"]);
  await f.enable();
  assertSchemas(true);
  assert.deepEqual(f.current.getActiveToolNames(), ["read", "do", "delegate"]);
  f.current.setActiveToolsByName(["read", "fresh_look"]);
  await f.current.prompt("/delegate-alt off");
  assertSchemas(false);
  assert.deepEqual(f.current.getActiveToolNames(), ["read", "fresh_look"], "manual fresh_look choice survives re-registration");
  await f.enable();
  assertSchemas(true);
  assert.deepEqual(f.current.getActiveToolNames(), ["read", "fresh_look"], "re-registration must not enable inactive ordinary tools");
  f.current.setActiveToolsByName(["read", ...toolNames]);
  for (const name of toolNames) {
    await f.run(name, { task: "Default" });
    await f.run(name, { task: "Explicit false", alt: false });
    await f.run(name, { task: "Other provider", alt: true }, "delegate-second", "off");
  }
  await f.current.setModel(f.second.getModel());
  await f.run("do", { task: "Reverse alternate", alt: true }, "delegate-first", "off");
  const arrived = f.holdNext();
  const pending = f.run("delegate", { task: "Pinned", alt: true }, "delegate-first", "off");
  await arrived;
  await f.current.prompt("/delegate-alt off");
  assertSchemas(false);
  f.release();
  await pending;
  fs.writeFileSync(f.config, JSON.stringify({ models: ["delegate-first/same-id", "delegate-second/same-id"] }));
  f.second.setResponses([(context) => {
    for (const name of toolNames) assert.ok(hasAlt(getCurrentTools(context.messages).find((tool) => tool.name === name)!));
    return fauxAssistantMessage("schema enabled before request");
  }]);
  await f.current.prompt("Check changed global selection.");
  assertSchemas(true);
  fs.rmSync(f.config);
  f.second.setResponses([(context) => {
    for (const name of toolNames) assert.ok(!hasAlt(getCurrentTools(context.messages).find((tool) => tool.name === name)!));
    return fauxAssistantMessage("schema disabled before request");
  }]);
  await f.current.prompt("Check disabled global selection.");
  assertSchemas(false);
});

test("all worker tools select the first configured model for an outside caller only with alt true", { timeout: 30_000 }, async (t) => {
  const f = await fixture(t);
  await f.enable();
  await f.current.setModel(f.third.getModel());
  f.current.setActiveToolsByName(["read", ...toolNames]);
  for (const name of toolNames) {
    await f.run(name, { task: "Outside caller default" }, "delegate-third");
    await f.run(name, { task: "Outside caller explicit false", alt: false }, "delegate-third");
    await f.run(name, { task: "Outside caller alternate", alt: true }, "delegate-first");
  }
  await f.current.prompt("/delegate-alt delegate-second/same-id delegate-first/same-id");
  await f.run("do", { task: "Reordered pair", alt: true }, "delegate-second", "off");
});

test("do inherits the pre-call conversation, delegate and fresh_look start blank in the selected directory", { timeout: 30_000 }, async (t) => {
  const f = await fixture(t);
  f.current.setActiveToolsByName(["read", ...toolNames]);
  await f.run("do", { task: "Inherited investigation" });
  const inherited = SessionManager.open(f.launches.at(-1)!.sessionFile);
  const inheritedRoles = () => inherited.getBranch().flatMap((entry) => entry.type === "message" ? [entry.message.role] : []);
  assert.deepEqual(inheritedRoles(), ["system", "user"]);
  assert.equal(inherited.getCwd(), f.directory);
  const other = path.join(f.directory, "other-project");
  fs.mkdirSync(other);
  for (const name of ["delegate", "fresh_look"] as const) {
    await f.run(name, { task: "Standalone assignment", folder: other });
    const launch = f.launches.at(-1)!;
    const child = SessionManager.open(launch.sessionFile);
    assert.equal(child.getCwd(), other);
    assert.ok(child.getBranch().every((entry) => entry.type !== "message"));
    assert.equal(launch.args.includes("--no-context-files"), name === "fresh_look");
    assert.equal(launch.args.includes("--no-skills"), name === "fresh_look");
    assert.equal(launch.args.includes("--no-prompt-templates"), name === "fresh_look");
    assert.equal(launch.args.includes("--system-prompt"), name === "fresh_look");
    assert.ok(!launch.args.includes("--no-extensions"));
  }
});

test("worker compaction guidance follows the enabled tool selection for all three worker tools", { timeout: 30_000 }, async (t) => {
  const f = await fixture(t);
  const guidance = "Use self_compact only when substantial work remains; never to wrap up.";
  for (const enabled of [false, true, false]) {
    const tools = ["read", ...toolNames, ...(enabled ? ["self_compact"] : [])];
    f.current.setActiveToolsByName(tools);
    for (const name of toolNames) {
      await f.run(name, { task: "Check worker guidance" });
      const request = f.requests.at(-1)!;
      assert.equal(request.task.includes(guidance), enabled);
      assert.equal(request.tools.includes("self_compact"), enabled);
      if (!enabled) assert.doesNotMatch(request.task, /self_compact/);
      assert.deepEqual(f.current.getActiveToolNames(), tools);
    }
  }
});

test("stale context arguments, do folder, and disabled alternate flags fail without starting workers", { timeout: 30_000 }, async (t) => {
  const f = await fixture(t);
  f.current.setActiveToolsByName(["read", ...toolNames]);
  const staleArguments: JsonObject[] = [{ context: "inherit" }, { context: "project" }, { context: "clean" }, { alt: true }, { alt: false }];
  for (const name of toolNames) {
    for (const extra of staleArguments) {
      const result = await f.call(name, { task: "Invalid old input", ...extra });
      assert.equal(result.isError, true, JSON.stringify(result));
      assert.equal(f.launches.length, 0);
    }
  }
  for (const folder of [f.directory, "/tmp"]) {
    const result = await f.call("do", { task: "Invalid cwd argument", folder });
    assert.equal(result.isError, true, JSON.stringify(result));
    assert.equal(f.launches.length, 0);
  }
  await f.enable();
  for (const name of toolNames) {
    const result = await f.call(name, { task: "Invalid alternate type", alt: "true" });
    assert.equal(result.isError, true, JSON.stringify(result));
    assert.equal(f.launches.length, 0);
  }
});

test("do warns only above 90 percent, permits retry, and restores the warning per branch and reload", { timeout: 30_000 }, async (t) => {
  const f = await fixture(t);
  f.current.setActiveToolsByName(["read", ...toolNames]);
  f.setPercent(90);
  await f.run("do", { task: "Exactly at threshold" });
  const beforeWarning = f.current.sessionManager.getLeafId()!;
  f.setPercent(90.1);
  const count = f.requests.length;
  const warning = await f.call("do", { task: "Above threshold" });
  assert.equal(warning.isError, false);
  assert.equal(f.requests.length, count, "warning must not start a worker");
  assert.equal((warning.details as { inheritContextWarning?: boolean }).inheritContextWarning, true);
  assert.match(JSON.stringify(warning.content), /90\.1%/);
  assert.match(JSON.stringify(warning.content), /Retry do/);
  const warnedBranch = f.current.sessionManager.getLeafId()!;
  await f.run("do", { task: "Explicit retry" });
  await f.current.reload();
  await f.run("do", { task: "Reload retains warning acknowledgment" });
  await f.current.navigateTree(beforeWarning, { summarize: false });
  const freshCount = f.requests.length;
  const newWarning = await f.call("do", { task: "New branch warns again" });
  assert.equal((newWarning.details as { inheritContextWarning?: boolean }).inheritContextWarning, true);
  assert.equal(f.requests.length, freshCount);
  await f.current.navigateTree(warnedBranch, { summarize: false });
  await f.run("do", { task: "Return to already warned branch" });
  f.current.setActiveToolsByName(["read", ...toolNames]);
  f.setPercent(99);
  await f.run("delegate", { task: "Standalone work at high context" });
  await f.run("fresh_look", { task: "Fresh work at high context" });
});

for (const name of toolNames) {
  test(`${name} publishes recovery before startup and preserves it through parent abort`, { timeout: 30_000 }, async (t) => {
    const f = await fixture(t);
    f.current.setActiveToolsByName(["read", ...toolNames]);
    const arrived = f.holdNext();
    const pending = f.call(name, { task: "Keep work recoverable" });
    await arrived;
    const file = f.launches.at(-1)!.sessionFile;
    const command = workerResumeCommand(file);
    assert.equal(f.updates[0].launches, 0, "receipt must precede host startup, not wait for native capture");
    const first = f.updates[0].result;
    assert.equal((first.details as { sessionCommand: string }).sessionCommand, command);
    assert.ok(!JSON.stringify(first.content).includes(command));
    assert.doesNotMatch(JSON.stringify(first.content), /To resume\/continue|enter a prompt to continue/);
    const saved = fs.readFileSync(file, "utf8");
    // Same SDK abort used by the parent's Escape key.
    await f.current.abort();
    const result = await pending;
    f.release();
    assert.equal(result.isError, true);
    assert.ok(JSON.stringify(result.content).includes(command));
    assert.equal(fs.readFileSync(file, "utf8"), saved, "closing a worker must not delete or rewrite its session");
    assert.equal(f.closed.length, 1);
    const parent = SessionManager.open(f.current.sessionManager.getSessionFile()!);
    assert.ok(parent.getBranch().some((entry) => entry.type === "message"
      && entry.message.role === "toolResult" && JSON.stringify(entry.message.content).includes(command)),
    "recovery must survive reloading the parent, not just the live progress row");
  });
}

test("provider/budget/token failures and failed startup retain model-visible recovery", { timeout: 30_000 }, async (t) => {
  const f = await fixture(t);
  for (const message of ["Insufficient credits", "Context window exceeded", "Maximum output tokens reached", "Provider unavailable"]) {
    f.failResult(message);
    const result = await f.call("delegate", { task: "Recover failed work" });
    const command = workerResumeCommand(f.launches.at(-1)!.sessionFile);
    assert.equal(result.isError, true);
    assert.ok(JSON.stringify(result.content).includes(command));
    assert.ok(JSON.stringify(result.content).includes(message));
  }
  f.failStartup("startup rejected");
  const result = await f.call("delegate", { task: "Recover failed startup" });
  assert.equal(result.isError, true);
  assert.ok(JSON.stringify(result.content).includes(workerResumeCommand(f.launches.at(-1)!.sessionFile)));
  assert.match(JSON.stringify(result.content), /startup rejected/);
});
