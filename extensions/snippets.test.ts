import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  DELEGATE_REVIEW_SUFFIX, DELEGATE_PROGRESS_SNIPPET, ENRICH_SNIPPET,
  SUPERVISE_SNIPPET, SNIPPETS,
} from "./snippets.ts";

test("review uses delegate while progress and supervision use do without a context selector", () => {
  for (const text of [DELEGATE_REVIEW_SUFFIX, DELEGATE_PROGRESS_SNIPPET, ENRICH_SNIPPET, SUPERVISE_SNIPPET]) {
    assert.doesNotMatch(text, /context\s*[:=]|fresh_look|retrospective/i);
  }
  assert.match(DELEGATE_REVIEW_SUFFIX, /^Use delegate \(alt=true if available\)/);
  assert.doesNotMatch(DELEGATE_REVIEW_SUFFIX, /\bdo\b/);
  assert.match(ENRICH_SNIPPET, /\bdo\b/);
  assert.match(DELEGATE_PROGRESS_SNIPPET, /^Use do/);
  assert.match(SUPERVISE_SNIPPET, /^Use do/);
  assert.match(SUPERVISE_SNIPPET, /delegate with a complete brief/);
  assert.doesNotMatch(SUPERVISE_SNIPPET, /\d+%/);
});

test("existing review and progress snippet shortcuts insert the new instructions", () => {
  assert.equal(SNIPPETS.find((snippet) => snippet.key === "delegate-review")?.value, DELEGATE_REVIEW_SUFFIX);
  assert.equal(SNIPPETS.find((snippet) => snippet.key === "delegate-progress")?.value, DELEGATE_PROGRESS_SNIPPET);
});

test("workflow plan reviews use do rather than requiring an opt-in clean tool", () => {
  const workflow = readFileSync(new URL("./workflow-template.md", import.meta.url), "utf8");
  assert.match(workflow, /review it with `do`/);
  assert.match(workflow, /Prefer `do`/);
  assert.doesNotMatch(workflow, /context\s*[:=]|fresh_look|clean-context/);
});
