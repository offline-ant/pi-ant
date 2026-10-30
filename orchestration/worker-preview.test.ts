import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import { createWorkerPreview } from "./worker-preview.ts";

function sessionFile(t: TestContext, content = ""): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-worker-preview-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "session.jsonl");
  if (content) fs.writeFileSync(file, content);
  return file;
}

const entry = (role: string, content: unknown): string => `${JSON.stringify({ type: "message", message: { role, content } })}\n`;
const text = (value: string) => [{ type: "text", text: value }];

test("a preview shows only what was added after it began, as text and tool calls", (t) => {
  const file = sessionFile(t, entry("user", "Inherited question") + entry("assistant", text("Inherited answer")));
  const preview = createWorkerPreview(file);
  assert.equal(preview(), "(no output yet)");
  fs.appendFileSync(file, [
    entry("user", "Worker task\n\nSecond paragraph"),
    entry("assistant", [{ type: "thinking", thinking: "Hidden" }, ...text("Looking\nCarefully"), { type: "toolCall", id: "1", name: "read", arguments: { path: "a.ts" } }]),
    entry("toolResult", text("Tool output is not shown")),
    `${JSON.stringify({ type: "custom", customType: "note", data: {} })}\n`,
  ].join(""));
  assert.equal(preview(), [
    "> Worker task", "> Second paragraph", "Looking", "Carefully", 'read {"path":"a.ts"}',
  ].join("\n"));
});

test("a missing file is empty, and a file that shrank restarts from its beginning", (t) => {
  const file = sessionFile(t);
  const preview = createWorkerPreview(file);
  assert.equal(preview(), "(no output yet)");
  fs.writeFileSync(file, entry("assistant", text("First")).repeat(4));
  assert.match(preview(), /First/);

  const rewritten = sessionFile(t, entry("assistant", text("Long inherited conversation")).repeat(4));
  const rewrittenPreview = createWorkerPreview(rewritten);
  fs.writeFileSync(rewritten, entry("assistant", text("Compacted")));
  assert.equal(rewrittenPreview(), "Compacted");
});

test("partial lines and oversized entries are skipped, and output stays bounded", (t) => {
  const file = sessionFile(t);
  const preview = createWorkerPreview(file);
  fs.writeFileSync(file, entry("assistant", text("Complete")) + '{"type":"message","mess');
  assert.equal(preview(), "Complete");

  // An entry larger than the tail leaves only its unparsable end to read.
  fs.appendFileSync(file, `age":${"x".repeat(600 * 1024)}\n`);
  assert.equal(preview(), "(no text output yet)");

  fs.appendFileSync(file, entry("assistant", text(Array.from({ length: 40 }, (_, index) => `line ${index}`).join("\n"))));
  const lines = preview().split("\n");
  assert.equal(lines.length, 12);
  assert.equal(lines.at(-1), "line 39");

  fs.appendFileSync(file, entry("assistant", text("y".repeat(100 * 1024))));
  assert.ok(Buffer.byteLength(preview()) <= 8192);
  fs.appendFileSync(file, entry("assistant", [{ type: "toolCall", id: "2", name: "write", arguments: { content: "z".repeat(10_000) } }]));
  assert.ok(preview().split("\n").at(-1)!.length < 150);
});
