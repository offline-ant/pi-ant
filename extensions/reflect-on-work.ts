import {
	buildSessionContext,
	convertToLlm,
	type ExtensionAPI,
	type ExtensionCommandContext,
	serializeConversation,
} from "@earendil-works/pi-coding-agent";
import { completeOnce } from "./model-request.ts";

const MESSAGE_TYPE = "reflect-on-work:report";
const WIDGET_KEY = "reflect-on-work";
const MAX_ANSWER_TOKENS = 8000;

const REVIEWER_SYSTEM_PROMPT = `You are one of five independent reviewers of the work done in a software engineering session.

You receive a text rendering of that session: user requests, assistant replies and thinking, tool calls, and tool results whose long outputs are truncated. You have no tools. You cannot read files, run commands, or check anything outside that rendering.

Answer only the review section you are assigned. Do not continue the conversation, do not do the work, and do not answer the other sections. Be critical, concrete, and evidence-based. Do not reassure. Cite what in the session supports each claim, and say plainly when the rendering does not show enough to judge.

Do not use level-1 or level-2 Markdown headings; your answer is inserted under a level-2 heading. Start any subsections at level 3.`;

export interface ReviewSection {
	id: string;
	heading: string;
	questions: readonly string[];
}

/** One section per review, in report order. */
export const REVIEW_SECTIONS: readonly ReviewSection[] = [
	{
		id: "confidence",
		heading: "Confidence & Assumptions",
		questions: [
			"Give your overall confidence in the implementation as a percentage.",
			"List anything you have low confidence in and explain why.",
			"List important assumptions you made.",
		],
	},
	{
		id: "requirements",
		heading: "Requirements & Coverage",
		questions: [
			"Compare the implementation against my original requirements.",
			"Identify anything partially satisfied, missing, or ambiguous.",
			"Identify what you have not investigated or verified.",
		],
	},
	{
		id: "risk",
		heading: "Risk & Failure Analysis",
		questions: [
			"Look for regressions, edge cases, race conditions, failure modes, and unintended effects elsewhere in the codebase.",
			"Tell me what is most likely to break in production or within the next few months.",
		],
	},
	{
		id: "complexity",
		heading: "Complexity & Maintainability",
		questions: [
			"Perform a YAGNI/complexity pass.",
			"Identify unnecessary abstractions, helpers, layers, or code.",
			"Do not remove existing functionality merely to simplify the implementation.",
		],
	},
	{
		id: "verification",
		heading: "Verification & Evidence",
		questions: [
			"List the tests or checks that would most increase your confidence.",
			"Clearly separate what you VERIFIED from what you merely INFERRED.",
			"Do not reassure me. Be critical and evidence-based.",
		],
	},
];

export interface ReviewResult {
	section: ReviewSection;
	text?: string;
	error?: string;
}

export function buildReviewPrompt(section: ReviewSection, conversationText: string): string {
	return [
		"<session>",
		conversationText,
		"</session>",
		"",
		`Your review section: ${section.heading}`,
		...section.questions.map((question) => `- ${question}`),
		"",
		"Answer only this section, using only the session above.",
	].join("\n");
}

export function formatReflectionReport(results: readonly ReviewResult[]): string {
	const parts = [
		"# Reflection",
		"",
		"Five independent reviewers each answered one section from a text rendering of this session. They had no tool access and long tool results were truncated.",
	];
	for (const result of results) {
		parts.push("", `## ${result.section.heading}`, "", result.text ?? `Review unavailable: ${result.error}`);
	}
	return parts.join("\n");
}

function statusWidget(states: ReadonlyMap<string, string>): string[] {
	return [
		"Reflection · five independent reviews",
		...REVIEW_SECTIONS.map((section) => `- ${section.heading}: ${states.get(section.id)}`),
	];
}

async function runReview(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	section: ReviewSection,
	conversationText: string,
): Promise<ReviewResult> {
	const response = await completeOnce(ctx, {
		systemPrompt: REVIEWER_SYSTEM_PROMPT,
		prompt: buildReviewPrompt(section, conversationText),
		maxTokens: MAX_ANSWER_TOKENS,
		sessionId: `reflect-on-work-${section.id}`,
		thinkingLevel: pi.getThinkingLevel(),
	});
	if (response.stopReason === "error") {
		return { section, error: response.errorMessage || "review failed" };
	}
	const text = response.content
		.filter((content) => content.type === "text")
		.map((content) => content.text)
		.join("\n")
		.trim();
	if (!text) return { section, error: "the model returned no text" };
	return {
		section,
		text: response.stopReason === "length" ? `${text}\n\n[cut off at the token cap]` : text,
	};
}

export default function reflectOnWorkExtension(pi: ExtensionAPI): void {
	pi.registerCommand("reflect-on-work", {
		description: "Review this session in five independent parallel reviews and insert one combined reflection",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			const { messages } = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId());
			const conversationText = serializeConversation(convertToLlm(messages));
			if (!conversationText.trim()) throw new Error("Nothing to reflect on: this session has no conversation yet");

			const states = new Map(REVIEW_SECTIONS.map((section) => [section.id, "running"]));
			ctx.ui.setWidget(WIDGET_KEY, statusWidget(states));
			try {
				const results = await Promise.all(
					REVIEW_SECTIONS.map(async (section) => {
						const result = await runReview(pi, ctx, section, conversationText).catch(
							(error: unknown): ReviewResult => ({
								section,
								error: error instanceof Error ? error.message : String(error),
							}),
						);
						states.set(section.id, result.text ? "done" : "failed");
						ctx.ui.setWidget(WIDGET_KEY, statusWidget(states));
						return result;
					}),
				);

				const succeeded = results.filter((result) => result.text).length;
				if (succeeded === 0) {
					throw new Error(`All five reviews failed. First error: ${results[0]?.error}`);
				}
				pi.sendMessage(
					{ customType: MESSAGE_TYPE, content: formatReflectionReport(results), display: true },
					{ triggerTurn: false },
				);
				ctx.ui.notify(
					`Reflection inserted into the session (${succeeded}/${results.length} reviews succeeded).`,
					succeeded === results.length ? "info" : "warning",
				);
			} finally {
				ctx.ui.setWidget(WIDGET_KEY, undefined);
			}
		},
	});
}
