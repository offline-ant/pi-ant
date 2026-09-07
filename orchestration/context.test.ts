import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { SessionManager, type ExtensionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
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
      { type: "toolCall", id: "a", name: "delegate", arguments: {} },
      { type: "toolCall", id: "b", name: "delegate", arguments: {} },
    ]));
    flushSessionFile(session, parentFile);
    const original = fs.readFileSync(parentFile, "utf8");
    const parentLeaf = session.getLeafId();
    const ctx = { cwd: root, sessionManager: session, thinkingLevel: "high", model: { provider: "fake", id: "fake" } } as unknown as ExtensionContext;
    for (const id of ["a", "b"]) {
      assert.equal(getPreToolCallLeafId(session, "delegate", id), before);
      const child = prepareDelegateSession({ context: "inherit", task: `Task ${id}` }, ctx, id, "high");
      childFiles.push(child.sessionFile);
      const fork = SessionManager.open(child.sessionFile);
      assert.equal(fork.getBranch().filter((entry) => entry.type === "message").length, 1);
      assert.deepEqual(child.args, ["--provider", "fake", "--model", "fake", "--thinking", "high"]);
    }
    assert.notEqual(childFiles[0], childFiles[1]);
    assert.equal(fs.readFileSync(parentFile, "utf8"), original);
    assert.equal(session.getLeafId(), parentLeaf);
    assert.throws(() => getPreToolCallLeafId(session, "delegate", "missing"), /refusing to fork/);
    assert.throws(() => prepareDelegateSession({ context: "inherit", task: "Task", folder: "/tmp" }, ctx, "a", "high"), /cannot change/);
    const project = prepareDelegateSession({ context: "project", task: "Task" }, ctx, "a", "high");
    childFiles.push(project.sessionFile);
    assert.equal(SessionManager.open(project.sessionFile).getBranch().filter((entry) => entry.type === "message").length, 0);
    const clean = prepareDelegateSession({ context: "clean", task: "Task" }, ctx, "a", "high");
    childFiles.push(clean.sessionFile);
    assert.ok(clean.args.includes("--no-context-files"));
    assert.ok(clean.args.includes("--no-extensions"));
  } finally {
    for (const file of childFiles) fs.rmSync(file, { force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
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
