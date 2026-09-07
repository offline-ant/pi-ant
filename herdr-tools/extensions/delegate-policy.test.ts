import assert from "node:assert/strict";
import test from "node:test";
import { cleanContextCliArgs, inheritContextWarningPercent } from "./delegate-policy.ts";

test("clean context disables discovered resources and explicitly reloads worker frame", () => {
  assert.deepEqual(cleanContextCliArgs("project", "/worker-frame.ts"), []);
  assert.deepEqual(cleanContextCliArgs("clean", "/worker-frame.ts"), [
    "--no-context-files",
    "--no-skills",
    "--no-prompt-templates",
    "--no-extensions",
    "--no-approve",
    "--system-prompt",
    "",
    "--append-system-prompt",
    "",
    "--extension",
    "/worker-frame.ts",
  ]);
});

test("only the first inherited delegate above 50 percent triggers the context warning", () => {
  assert.equal(inheritContextWarningPercent("inherit", 50, false), undefined);
  assert.equal(inheritContextWarningPercent("inherit", 50.1, false), 50.1);
  assert.equal(inheritContextWarningPercent("inherit", 75, true), undefined);
  assert.equal(inheritContextWarningPercent("inherit", null, false), undefined);
  assert.equal(inheritContextWarningPercent("project", 75, false), undefined);
});
