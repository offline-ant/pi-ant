import assert from "node:assert/strict";
import test from "node:test";
import { activeTools, parseToolSelection, sameToolSelection, toggleTool } from "./tool-selection.ts";

test("selections parse to unique tool names and reject other shapes", () => {
  assert.deepEqual(parseToolSelection({ enabledTools: ["read", "read", "bash"] }), ["read", "bash"]);
  assert.equal(parseToolSelection({ enabledTools: ["read", 1] }), undefined);
  assert.equal(parseToolSelection(["read"]), undefined);
  assert.equal(parseToolSelection(null), undefined);
});

test("toggling returns a new selection and equality ignores order", () => {
  const original = ["read"];
  const added = toggleTool(original, "browser");
  assert.deepEqual(added, ["read", "browser"]);
  assert.deepEqual(toggleTool(added, "read"), ["browser"]);
  assert.deepEqual(original, ["read"]);
  assert.equal(sameToolSelection(["read", "bash"], ["bash", "read"]), true);
  assert.equal(sameToolSelection(["read"], ["read", "bash"]), false);
});

test("active tools filter unavailable entries and add required tools", () => {
  assert.deepEqual(activeTools(["read", "gone"], ["read", "bash", "present_guidance"], ["present_guidance"]), ["read", "present_guidance"]);
});
