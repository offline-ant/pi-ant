import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { collectReads } from "./context-explorer.ts";

function sessionMessage(message: Record<string, unknown>): string {
  return JSON.stringify({ type: "message", message });
}

test("read coverage resolves relative paths from cwd and counts returned lines", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "context-explorer-test-"));
  const sourcePath = path.join(cwd, "source.txt");
  const sessionPath = path.join(cwd, "session.jsonl");
  fs.writeFileSync(sourcePath, Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n"));

  const entries = [
    sessionMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "old-read", name: "read", arguments: { path: "source.txt" } }],
    }),
    sessionMessage({ role: "toolResult", toolName: "read", toolCallId: "old-read", isError: false }),
    JSON.stringify({ type: "compaction" }),
    sessionMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "limited-read", name: "read", arguments: { path: "@source.txt", offset: 2, limit: 3 } }],
    }),
    sessionMessage({ role: "toolResult", toolName: "read", toolCallId: "limited-read", isError: false }),
    sessionMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "truncated-read", name: "read", arguments: { path: "source.txt", offset: 5 } }],
    }),
    sessionMessage({
      role: "toolResult",
      toolName: "read",
      toolCallId: "truncated-read",
      isError: false,
      details: { truncation: { truncated: true, outputLines: 2 } },
    }),
  ];
  fs.writeFileSync(sessionPath, `${entries.join("\n")}\n`);

  try {
    assert.equal(collectReads(sessionPath, cwd).get(sourcePath), 50);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("failed reads do not count toward coverage", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "context-explorer-test-"));
  const sourcePath = path.join(cwd, "source.txt");
  const sessionPath = path.join(cwd, "session.jsonl");
  fs.writeFileSync(sourcePath, "one\ntwo\nthree\n");
  fs.writeFileSync(sessionPath, `${[
    sessionMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "failed-read", name: "read", arguments: { path: "source.txt" } }],
    }),
    sessionMessage({ role: "toolResult", toolName: "read", toolCallId: "failed-read", isError: true }),
  ].join("\n")}\n`);

  try {
    assert.equal(collectReads(sessionPath, cwd).has(sourcePath), false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
