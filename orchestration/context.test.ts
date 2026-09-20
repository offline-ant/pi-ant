import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fauxProvider, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime, resolveCliModel, SessionManager, type ExtensionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { collectHistoryItems, flushSessionFile, getPreToolCallLeafId, modelCliArgs, prepareDelegateSession } from "./context.ts";

function assistant(content: Extract<Extract<SessionEntry, { type: "message" }>["message"], { role: "assistant" }>["content"]): Extract<Extract<SessionEntry, { type: "message" }>["message"], { role: "assistant" }> {
  return { role: "assistant", content, timestamp: Date.now(), stopReason: "stop", api: "openai-responses", provider: "fake", model: "fake", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}

test("inherited sessions fork before sibling calls without changing parent branch or file", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-context-test-"));
  const session = SessionManager.create(root, root);
  const parentFile = session.getSessionFile()!;
  const childFiles: string[] = [];
  try {
    const before = session.appendMessage({ role: "user", content: "Shared context", timestamp: Date.now() });
    session.appendMessage(assistant([
      { type: "toolCall", id: "a", name: "do", arguments: {} },
      { type: "toolCall", id: "b", name: "do", arguments: {} },
      { type: "toolCall", id: "standalone", name: "delegate", arguments: {} },
    ]));
    flushSessionFile(session, parentFile);
    const original = fs.readFileSync(parentFile, "utf8");
    const parentLeaf = session.getLeafId();
    const ctx = { cwd: root, sessionManager: session, thinkingLevel: "high", model: { provider: "fake", id: "fake" } } as unknown as ExtensionContext;
    const runtime = { model: { provider: "other", id: "alternate" }, thinkingLevel: "high" };
    for (const id of ["a", "b"]) {
      assert.equal(getPreToolCallLeafId(session, "do", id), before);
      const child = prepareDelegateSession({ tool: "do", task: `Task ${id}` }, ctx, id, runtime);
      childFiles.push(child.sessionFile);
      const fork = SessionManager.open(child.sessionFile);
      assert.equal(fork.getBranch().filter((entry) => entry.type === "message").length, 1);
      assert.deepEqual(child.args, ["--provider", "other", "--model", "alternate", "--thinking", "high"]);
    }
    assert.notEqual(childFiles[0], childFiles[1]);
    assert.equal(fs.readFileSync(parentFile, "utf8"), original);
    assert.equal(session.getLeafId(), parentLeaf);
    assert.throws(() => getPreToolCallLeafId(session, "do", "missing"), /refusing to fork/);
    assert.throws(() => prepareDelegateSession({ tool: "do", task: "Task" }, ctx, "standalone", runtime), /refusing to fork/);
    assert.throws(() => prepareDelegateSession({ tool: "do", task: "Task", folder: "/tmp" }, ctx, "a", runtime), /cannot change|folder/);
    const otherFolder = path.join(root, "other-project");
    fs.mkdirSync(otherFolder);
    const project = prepareDelegateSession({ tool: "delegate", task: "Task", folder: otherFolder }, ctx, "standalone", runtime);
    childFiles.push(project.sessionFile);
    assert.equal(SessionManager.open(project.sessionFile).getBranch().filter((entry) => entry.type === "message").length, 0);
    assert.equal(project.cwd, otherFolder);
    assert.equal(SessionManager.open(project.sessionFile).getCwd(), otherFolder);
    const clean = prepareDelegateSession({ tool: "fresh_look", task: "Task", folder: otherFolder }, ctx, "a", runtime);
    childFiles.push(clean.sessionFile);
    assert.equal(clean.cwd, otherFolder);
    assert.equal(SessionManager.open(clean.sessionFile).getBranch().filter((entry) => entry.type === "message").length, 0);
    assert.ok(clean.args.includes("--no-context-files"));
    assert.ok(!clean.args.includes("--no-extensions"));
    assert.deepEqual(project.args, ["--provider", "other", "--model", "alternate", "--thinking", "high"]);
    assert.deepEqual(clean.args.slice(0, 6), project.args);
    assert.deepEqual(ctx.model, { provider: "fake", id: "fake" }, "selected worker model must not change the parent");
  } finally {
    for (const file of childFiles) fs.rmSync(file, { force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("child model arguments round-trip through Pi's CLI resolver or explicitly reject ambiguous identifiers", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-model-cli-test-"));
  try {
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(), modelsPath: null,
      modelsStorePath: path.join(root, "models-store.json"), refreshOnCreate: false,
    });
    const provider = fauxProvider({ provider: "example", models: [
      { id: "review" }, { id: "vendor/review" }, { id: "review:high" }, { id: "example/review" },
    ] });
    runtime.registerNativeProvider(provider.provider);
    for (const model of provider.models.slice(0, 3)) {
      const args = modelCliArgs(model, "off");
      const resolved = resolveCliModel({ cliProvider: args[1], cliModel: args[3], cliThinking: "off", modelRuntime: runtime });
      assert.equal(resolved.error, undefined);
      assert.equal(resolved.warning, undefined);
      assert.equal(resolved.model?.provider, model.provider);
      assert.equal(resolved.model?.id, model.id);
    }
    // The unguarded old arguments resolve to review, not the requested example/review.
    assert.equal(resolveCliModel({ cliProvider: "example", cliModel: "example/review", modelRuntime: runtime }).model?.id, "review");
    assert.throws(() => modelCliArgs(provider.models[3], "off"), /provider prefix ambiguously/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("history uses Pi context entries and omits tool activity", () => {
  const session = SessionManager.inMemory("/tmp");
  session.appendMessage({ role: "user", content: "Question", timestamp: Date.now() });
  session.appendMessage(assistant([{ type: "text", text: "Answer" }]));
  session.appendMessage(assistant([{ type: "toolCall", id: "call", name: "read", arguments: {} }]));
  session.appendMessage({ role: "toolResult", toolName: "read", toolCallId: "call", content: [{ type: "text", text: "Hidden tool output" }], isError: false, timestamp: Date.now() });
  assert.deepEqual(collectHistoryItems(session.buildContextEntries(), 1), [
    { role: "user", text: "Question" }, { role: "assistant", text: "Answer" },
  ]);
  assert.deepEqual(collectHistoryItems(session.buildContextEntries(), 0), []);
  const newest = session.appendMessage({ role: "user", content: "After compaction", timestamp: Date.now() });
  session.appendCompaction("Summary", newest, 100);
  assert.deepEqual(collectHistoryItems(session.buildContextEntries(), 10), [{ role: "user", text: "After compaction" }]);
  assert.throws(() => modelCliArgs(undefined, "high"), /no selected model/);
});
