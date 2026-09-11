import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component } from "@earendil-works/pi-tui";
import delegateExtension from "./extensions/delegate.ts";
import codingAgentExtension from "./extensions/coding-agent.ts";
import freshHistoryExtension from "./extensions/fresh-history.ts";
import { renderWorkerCall } from "./worker-call.ts";

function lines(component: Component, width = 100): string[] {
  return component.render(width).map((line) => line.trimEnd());
}

for (const [name, extension, field] of [
  ["delegate", delegateExtension, "task"],
  ["coding-agent", codingAgentExtension, "task"],
  ["fresh-history", freshHistoryExtension, "prompt"],
] as const) {
  test(`${name} preview renders real paragraphs without changing arguments`, () => {
    let registered: { name: string; renderCall(args: Record<string, unknown>): Component } | undefined;
    extension({
      on: () => {},
      events: { on: () => () => {} },
      registerTool: (tool: typeof registered) => { registered = tool; },
    } as unknown as ExtensionAPI);
    assert.equal(registered?.name, name);
    const args = Object.freeze({ [field]: 'First "paragraph".\n\n  Indented second paragraph.\n' });
    const before = JSON.stringify(args);
    assert.deepEqual(lines(registered!.renderCall(args)), [
      `${name}(`,
      `  ${field}:`,
      '    First "paragraph".',
      "",
      "      Indented second paragraph.",
      "",
      ")",
    ]);
    assert.equal(JSON.stringify(args), before);
  });
}

test("literal backslash escapes stay literal while CRLF becomes a line break", () => {
  assert.deepEqual(lines(renderWorkerCall("delegate", { task: 'Keep \\n and C:\\new\\test.\r\nNext line.' })), [
    "delegate(",
    "  task:",
    '    Keep \\n and C:\\new\\test.',
    "    Next line.",
    ")",
  ]);
});

test("metadata and partial streamed arguments remain visible", () => {
  assert.deepEqual(lines(renderWorkerCall("delegate", {})), ["delegate(", ")"]);
  assert.deepEqual(lines(renderWorkerCall("delegate", {
    context: "project", folder: "/tmp/work folder", task: "", history: 0,
  })), [
    "delegate(", "  context: project", "  folder: /tmp/work folder", "  task:", "  history: 0", ")",
  ]);
});

test("multiline previews wrap within terminal width and survive resize/invalidation", () => {
  const component = renderWorkerCall("delegate", {
    task: `First paragraph with enough words to wrap onto several terminal lines.\n\n${"abcdefghij".repeat(10)}\nUnicode: 界面 café.`,
  });
  const wide = component.render(100);
  for (const width of [12, 40, 80]) {
    const rendered = component.render(width);
    assert.ok(rendered.every((line) => visibleWidth(line) <= width));
    assert.ok(rendered.some((line) => !line.trim()), "paragraph break must remain visible");
    assert.ok(!rendered.join("\n").includes("\\n"));
  }
  component.invalidate();
  assert.deepEqual(component.render(100), wide);
});
