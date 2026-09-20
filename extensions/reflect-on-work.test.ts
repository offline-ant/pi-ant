import assert from "node:assert/strict";
import test from "node:test";
import { buildReviewPrompt, formatReflectionReport, REVIEW_SECTIONS } from "./reflect-on-work.ts";

test("five review sections cover the requested topics in report order", () => {
	assert.deepEqual(
		REVIEW_SECTIONS.map((section) => section.heading),
		[
			"Confidence & Assumptions",
			"Requirements & Coverage",
			"Risk & Failure Analysis",
			"Complexity & Maintainability",
			"Verification & Evidence",
		],
	);
	assert.equal(new Set(REVIEW_SECTIONS.map((section) => section.id)).size, REVIEW_SECTIONS.length);
	assert.ok(REVIEW_SECTIONS.every((section) => section.questions.length > 0));
});

test("a review prompt carries the session and only its own questions", () => {
	const section = REVIEW_SECTIONS[1];
	const prompt = buildReviewPrompt(section, "[User]: build it\n\n[Assistant]: done");
	assert.match(prompt, /<session>\n\[User\]: build it/);
	assert.match(prompt, /Your review section: Requirements & Coverage/);
	for (const question of section.questions) assert.ok(prompt.includes(question));
	for (const question of REVIEW_SECTIONS[0].questions) assert.ok(!prompt.includes(question));
});

test("the report concatenates answers verbatim under one heading each", () => {
	const report = formatReflectionReport([
		{ section: REVIEW_SECTIONS[0], text: "### Confidence\n70%" },
		{ section: REVIEW_SECTIONS[1], error: "stream terminated" },
	]);
	assert.match(report, /^# Reflection\n/);
	assert.ok(report.includes("## Confidence & Assumptions\n\n### Confidence\n70%"));
	assert.ok(report.includes("## Requirements & Coverage\n\nReview unavailable: stream terminated"));
	assert.equal(report.match(/^# /gm)?.length, 1);
	assert.equal(report.match(/^## /gm)?.length, 2);
});
