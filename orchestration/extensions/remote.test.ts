import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { installSshStub, setSessionRemote } from "../test/ssh-stub.ts";
import remoteExtension from "./remote.ts";

/** Real Pi SDK session with the extension loaded; tools reach the stub "remote" through ssh. */
async function session(t: TestContext, spec: (home: string) => string | undefined) {
  const stub = installSshStub(t);
  const local = path.join(stub.root, "local");
  const agentDir = path.join(stub.root, "agent");
  fs.mkdirSync(local);
  fs.mkdirSync(agentDir);
  fs.writeFileSync(path.join(local, "AGENTS.md"), "LOCAL PROJECT RULES");
  fs.writeFileSync(path.join(agentDir, "AGENTS.md"), "GLOBAL USER RULES");
  setSessionRemote(t, spec(stub.home));
  const faux = fauxProvider({ provider: "remote-faux", models: [{ id: "model" }], tokensPerSecond: 100_000 });
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsPath: null,
    modelsStorePath: path.join(agentDir, "models-store.json"), allowModelNetwork: false,
  });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const loader = new DefaultResourceLoader({
    cwd: local, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    extensionFactories: [(pi) => { pi.registerProvider(faux.provider); remoteExtension(pi); }],
  });
  await loader.reload();
  const created = await createAgentSession({
    cwd: local, agentDir, modelRuntime, settingsManager, resourceLoader: loader,
    model: faux.getModel(), tools: ["read", "bash", "grep"],
    sessionManager: SessionManager.create(local, path.join(stub.root, "sessions")),
  });
  assert.deepEqual(created.extensionsResult.errors, []);
  const errors: string[] = [];
  await created.session.bindExtensions({ mode: "print", onError: (error) => errors.push(error.error) });
  await modelRuntime.setRuntimeApiKey(faux.provider.id, "fixture-key");
  await modelRuntime.getAvailable();
  t.after(() => {
    created.session.dispose();
    assert.deepEqual(errors, []);
  });
  return { stub, local, faux, session: created.session };
}

test("a remote session runs tools over ssh and describes the remote project", { timeout: 30_000 }, async (t) => {
  const f = await session(t, (home) => {
    fs.mkdirSync(path.join(home, "proj"));
    fs.writeFileSync(path.join(home, "proj", "AGENTS.md"), "REMOTE PROJECT RULES");
    return `box:${path.join(home, "proj")}`;
  });
  const remote = path.join(f.stub.home, "proj");
  let systemPrompt = "";
  f.faux.setResponses([
    () => {
      systemPrompt = f.session.systemPrompt;
      return fauxAssistantMessage(fauxToolCall("bash", { command: "pwd" }), { stopReason: "toolUse" });
    },
    fauxAssistantMessage(fauxToolCall("grep", { pattern: "x" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("done"),
  ]);
  assert.ok(!f.session.getActiveToolNames().includes("grep"), "grep is deactivated in remote sessions");
  f.session.setActiveToolsByName(["read", "bash", "grep"]);
  await f.session.prompt("Where are you?");
  const results = f.session.messages.filter((message) => message.role === "toolResult");
  assert.equal(JSON.stringify(results[0]?.content).includes(remote), true, JSON.stringify(results[0]));
  assert.equal(results[1]?.isError, true);
  assert.match(JSON.stringify(results[1]?.content), /Use rg through bash/);
  assert.match(systemPrompt, new RegExp(`<cwd>\\n${remote}\\n</cwd>`));
  assert.match(systemPrompt, /REMOTE PROJECT RULES/);
  assert.match(systemPrompt, /GLOBAL USER RULES/);
  assert.doesNotMatch(systemPrompt, /LOCAL PROJECT RULES/);
  assert.match(systemPrompt, /<remote>\nTools run on the remote host box over SSH/);
  const marker = f.session.sessionManager.getBranch().findLast((entry) => entry.type === "custom" && entry.customType === "pi-orchestration:remote");
  assert.deepEqual(marker?.type === "custom" && marker.data, { target: `box:${remote}` });
});

test("an unreachable remote never falls back to local execution or a local prompt", { timeout: 30_000 }, async (t) => {
  const f = await session(t, () => "down:/srv");
  let systemPrompt = "";
  f.faux.setResponses([
    () => {
      systemPrompt = f.session.systemPrompt;
      return fauxAssistantMessage(fauxToolCall("bash", { command: "touch ran-locally" }), { stopReason: "toolUse" });
    },
    fauxAssistantMessage("done"),
  ]);
  await f.session.prompt("Try.");
  const result = f.session.messages.findLast((message) => message.role === "toolResult");
  assert.equal(result?.isError, true);
  assert.match(JSON.stringify(result?.content), /SSH connection to down failed/);
  assert.ok(!fs.existsSync(path.join(f.local, "ran-locally")));
  assert.match(systemPrompt, /<cwd>\ndown:\/srv \(unreachable\)\n<\/cwd>/);
  assert.match(systemPrompt, /unavailable: SSH connection to down failed/);
  assert.doesNotMatch(systemPrompt, /LOCAL PROJECT RULES/);
});

test("local sessions keep the built-in tools", { timeout: 30_000 }, async (t) => {
  const f = await session(t, () => undefined);
  f.faux.setResponses([fauxAssistantMessage(fauxToolCall("bash", { command: "pwd" }), { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
  assert.ok(f.session.getActiveToolNames().includes("grep"));
  await f.session.prompt("Where?");
  assert.match(JSON.stringify(f.session.messages.findLast((message) => message.role === "toolResult")?.content), new RegExp(f.local));
  assert.deepEqual(f.stub.scripts(), []);
  assert.match(f.session.systemPrompt, /LOCAL PROJECT RULES/);
});
