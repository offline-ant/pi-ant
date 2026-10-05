import assert from "node:assert/strict";
import test from "node:test";
import { initTheme, type AgentToolResult, type ExtensionAPI, type Theme, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import delegateExtension from "./extensions/delegate.ts";
import { workerResumeHint } from "./worker-resume.ts";
import { renderWorkerResult } from "./worker-result.ts";

initTheme("dark", false);
const theme = { fg: (_color: string, text: string) => text } as Theme;
const command = "env -u PI_NESTED pi --session '/tmp/worker session.jsonl'";

for (const name of ["do", "delegate", "fresh_look"]) {
  test(`${name} registers the shared result renderer`, () => {
    let registered: ToolDefinition | undefined;
    delegateExtension({
      on: () => {},
      events: { on: () => () => {} },
      registerTool: (tool: ToolDefinition) => { if (tool.name === name) registered = tool; },
      registerCommand: () => {},
    } as unknown as ExtensionAPI);
    assert.equal(registered?.renderResult, renderWorkerResult);
  });
}

for (const isPartial of [false, true]) {
  test(`${isPartial ? "progress" : "success"} displays recovery as user-only without changing model content`, () => {
    const result: AgentToolResult<unknown> = {
      content: [{ type: "text", text: "Worker model: fixture/model\nWorker result." }],
      details: { sessionCommand: command },
    };
    const before = JSON.stringify(result);
    for (const expanded of [false, true]) {
      const rendered = renderWorkerResult(result, { expanded, isPartial }, theme).render(200).join("\n");
      assert.match(rendered, /User-only recovery command \(not sent to model\):/);
      assert.ok(rendered.includes(command));
      assert.match(rendered, /after the worker stops/);
      assert.match(rendered, /Worker result\./);
      assert.equal(JSON.stringify(result), before);
      assert.ok(!JSON.stringify(result.content).includes(command));
    }
  });
}

test("errors retain model-visible recovery and are never labeled user-only", () => {
  const result = {
    content: [{ type: "text" as const, text: `${workerResumeHint(command)}\nProvider unavailable` }],
    details: undefined,
  };
  const rendered = renderWorkerResult(result, { expanded: false, isPartial: false }, theme).render(200).join("\n");
  assert.ok(rendered.includes(command));
  assert.match(rendered, /Provider unavailable/);
  assert.doesNotMatch(rendered, /User-only|not sent to model/);
});

test("results without recovery metadata render normally, including pre-start warnings", () => {
  const result = { content: [{ type: "text" as const, text: "do not started: Retry do to proceed." }], details: undefined };
  assert.deepEqual(renderWorkerResult(result, { expanded: false, isPartial: false }, theme).render(100).map((line) => line.trimEnd()), [
    "do not started: Retry do to proceed.",
  ]);
});

test("collapsed output is bounded, expanded output is complete, and recovery survives resize", () => {
  const result = {
    content: [{ type: "text" as const, text: Array.from({ length: 30 }, (_, index) => `line ${index}`).join("\n") }],
    details: { sessionCommand: command },
  };
  const collapsed = renderWorkerResult(result, { expanded: false, isPartial: false }, theme);
  const text = collapsed.render(200).join("\n");
  assert.match(text, /20 more lines/);
  assert.match(text, /line 9/);
  assert.doesNotMatch(text, /line 10/);
  assert.ok(text.includes(command));
  const expanded = renderWorkerResult(result, { expanded: true, isPartial: false }, theme).render(200).join("\n");
  assert.match(expanded, /line 29/);
  assert.doesNotMatch(expanded, /more lines/);
  const wide = collapsed.render(200);
  for (const width of [12, 40, 80]) {
    assert.ok(collapsed.render(width).every((line) => visibleWidth(line) <= width));
  }
  collapsed.invalidate();
  assert.deepEqual(collapsed.render(200), wide);
});
