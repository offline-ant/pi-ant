import assert from "node:assert/strict";
import test from "node:test";
import { cleanContextCliArgs, EPHEMERAL_WORKER_CONTEXTS, inheritContextWarningPercent } from "./delegate-policy.ts";

test("each public worker tool has exactly one context mode", () => {
  assert.deepEqual(EPHEMERAL_WORKER_CONTEXTS, { do: "inherit", delegate: "project", fresh_look: "clean" });
});

test("clean context blanks the conversation but keeps extensions, which register providers", () => {
  assert.deepEqual(cleanContextCliArgs("project", "/worker-frame.ts"), []);
  assert.deepEqual(cleanContextCliArgs("clean", "/worker-frame.ts"), [
    "--no-context-files",
    "--no-skills",
    "--no-prompt-templates",
    "--no-approve",
    "--system-prompt",
    "",
    "--append-system-prompt",
    "",
    "--extension",
    "/worker-frame.ts",
  ]);
});

test("only the first inherited worker above 90 percent triggers the context warning", () => {
  for (const percent of [50, 50.1, 75, 80, 80.1, 90]) {
    assert.equal(inheritContextWarningPercent("inherit", percent, false), undefined);
  }
  assert.equal(inheritContextWarningPercent("inherit", 90.1, false), 90.1);
  assert.equal(inheritContextWarningPercent("inherit", 95, true), undefined);
  assert.equal(inheritContextWarningPercent("inherit", null, false), undefined);
  assert.equal(inheritContextWarningPercent("inherit", undefined, false), undefined);
  assert.equal(inheritContextWarningPercent("project", 95, false), undefined);
  assert.equal(inheritContextWarningPercent("clean", 95, false), undefined);
});
