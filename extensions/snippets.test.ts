import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  DELEGATE_REVIEW_SUFFIX, DELEGATE_PROGRESS_SNIPPET, ENRICH_SNIPPET,
  SUPERVISE_SNIPPET, SNIPPETS,
} from "./snippets.ts";

test("review, progress, and supervision snippets prefer do without a context selector", () => {
  for (const text of [DELEGATE_REVIEW_SUFFIX, DELEGATE_PROGRESS_SNIPPET, ENRICH_SNIPPET, SUPERVISE_SNIPPET]) {
    assert.match(text, /\bdo\b/);
    assert.doesNotMatch(text, /context\s*[:=]|fresh_look|retrospective/i);
  }
  assert.match(DELEGATE_REVIEW_SUFFIX, /^Use do \(alt=true if available\)/);
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
