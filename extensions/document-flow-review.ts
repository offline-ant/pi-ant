import * as path from "node:path";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import {
	runDocumentFlowReview,
	type DocumentFlowReviewRunResult,
} from "./document-flow-review-runner.ts";

const ENTRY_TYPE = "document-flow-review:result";
const TOOL_NAME = "document_flow_review";

const documentFlowReviewToolSchema = Type.Object({
	file: Type.String({
		minLength: 1,
		description: "Document path, resolved relative to the current working directory.",
	}),
	prompt: Type.Optional(Type.String({
		description: "Optional reader profile, audience, or internal-coherence focus. Must not request factual or external validation.",
	})),
});

type DocumentFlowReviewToolParams = Static<typeof documentFlowReviewToolSchema>;

interface ParsedCommand {
	documentPath: string;
	profile?: string;
}

interface ReviewMessageDetails {
	report: string;
	reportPath: string;
	sessionPath: string;
	sourcePath: string;
	unitCount: number;
}

interface DocumentFlowReviewToolDetails {
	status: "running" | "complete";
	reportPath?: string;
	metadataPath?: string;
	sessionPath?: string;
	sourcePath?: string;
	unitCount?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function parseShellWords(input: string): string[] {
	const words: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let escaping = false;

	for (const character of input.trim()) {
		if (escaping) {
			current += character;
			escaping = false;
			continue;
		}
		if (character === "\\" && quote !== "'") {
			escaping = true;
			continue;
		}
		if (quote) {
			if (character === quote) quote = undefined;
			else current += character;
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			continue;
		}
		if (/\s/.test(character)) {
			if (current) {
				words.push(current);
				current = "";
			}
			continue;
		}
		current += character;
	}

	if (escaping) current += "\\";
	if (quote) throw new Error("Unclosed quote in command arguments.");
	if (current) words.push(current);
	return words;
}

function parseCommand(input: string): ParsedCommand {
	const words = parseShellWords(input);
	if (words.length === 0) {
		throw new Error("Usage: /document-flow-review <document-path> [--profile <reader profile>]");
	}
	const profileFlag = words.indexOf("--profile");
	if (profileFlag === 0) throw new Error("Document path must come before --profile.");
	if (profileFlag >= 0 && profileFlag !== 1) {
		throw new Error("Quote document paths containing spaces, then place --profile after the path.");
	}
	if (profileFlag < 0 && words.length > 1) {
		throw new Error("Quote document paths containing spaces. Reader profiles must follow --profile.");
	}
	const documentPath = words[0]?.replace(/^@/, "");
	if (!documentPath) throw new Error("Document path cannot be empty.");
	const profile = profileFlag >= 0 ? words.slice(profileFlag + 1).join(" ").trim() : undefined;
	if (profileFlag >= 0 && !profile) throw new Error("Reader profile cannot be empty.");
	return { documentPath, profile };
}

function reviewMessageDetails(value: unknown): ReviewMessageDetails | undefined {
	if (!isRecord(value)) return undefined;
	if (
		typeof value.report !== "string" ||
		typeof value.reportPath !== "string" ||
		typeof value.sessionPath !== "string" ||
		typeof value.sourcePath !== "string" ||
		typeof value.unitCount !== "number"
	) {
		return undefined;
	}
	return {
		report: value.report,
		reportPath: value.reportPath,
		sessionPath: value.sessionPath,
		sourcePath: value.sourcePath,
		unitCount: value.unitCount,
	};
}

function formatParentResult(result: DocumentFlowReviewRunResult): string {
	return [
		result.report,
		"",
		`Report: ${result.reportPath}`,
		`Metadata: ${result.metadataPath}`,
		`Session: ${result.sessionPath}`,
	].join("\n");
}

export default function documentFlowReviewExtension(pi: ExtensionAPI): void {
	pi.registerMessageRenderer(ENTRY_TYPE, (message, _options, theme) => {
		const data = reviewMessageDetails(message.details);
		if (!data) return new Text(theme.fg("error", "Document flow review result is malformed."), 0, 0);
		const header = theme.fg(
			"accent",
			theme.bold(`Document flow review: ${path.basename(data.sourcePath)} (${data.unitCount} reading units)`),
		);
		const paths = theme.fg("dim", `Report: ${data.reportPath}\nSession: ${data.sessionPath}`);
		return new Text(`${header}\n${paths}\n\n${data.report}`, 0, 0);
	});

	pi.registerTool(defineTool<typeof documentFlowReviewToolSchema, DocumentFlowReviewToolDetails>({
			name: TOOL_NAME,
			label: "Document Flow Review",
			description: "Read one document strictly in sequence without lookahead and review whether each part follows coherently and consistently from earlier parts. Use for internal logical flow, definitions, transitions, expectations, internal contradictions, and misplaced or late information. Do not use to verify factual truth, external validity, real-world correctness, or agreement with project context. Returns the final review and artifact paths.",
			promptSnippet: "Review one document's internal coherence by reading it sequentially without lookahead",
			promptGuidelines: [
				"Use document_flow_review when the user asks whether a single document is internally coherent or logically sequenced.",
				"Do not use it to validate factual claims, establish external correctness, or compare the document with a project or other sources.",
			],
			parameters: documentFlowReviewToolSchema,
			async execute(_toolCallId, params: DocumentFlowReviewToolParams, signal, onUpdate, ctx) {
				const result = await runDocumentFlowReview(
					pi,
					ctx,
					{ file: params.file, prompt: params.prompt },
					(text) => onUpdate?.({
						content: [{ type: "text", text }],
						details: { status: "running" } satisfies DocumentFlowReviewToolDetails,
					}),
					signal,
				);
				return {
					content: [{ type: "text", text: formatParentResult(result) }],
					details: {
						status: "complete",
						reportPath: result.reportPath,
						metadataPath: result.metadataPath,
						sessionPath: result.sessionPath,
						sourcePath: result.sourcePath,
						unitCount: result.unitCount,
					} satisfies DocumentFlowReviewToolDetails,
				};
			},
			renderCall(args, theme) {
				return new Text(
					theme.fg("toolTitle", theme.bold("document_flow_review ")) + theme.fg("accent", args.file),
					0,
					0,
				);
			},
		}));

	pi.registerCommand("document-flow-review", {
		description: "Review one document's internal coherence sequentially without lookahead: /document-flow-review <path> [--profile <text>]",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			try {
				const parsed = parseCommand(args);
				const result = await runDocumentFlowReview(
					pi,
					ctx,
					{ file: parsed.documentPath, readerProfile: parsed.profile },
					(text) => ctx.ui.setWidget("document-flow-review", text.split("\n")),
				);
				const details = {
					report: result.report,
					reportPath: result.reportPath,
					sessionPath: result.sessionPath,
					sourcePath: result.sourcePath,
					unitCount: result.unitCount,
				} satisfies ReviewMessageDetails;
				const relativeSourcePath = path.relative(ctx.cwd, result.sourcePath) || path.basename(result.sourcePath);
				pi.sendMessage({
					customType: ENTRY_TYPE,
					content: `An isolated sequential reader reviewed the internal coherence of ${relativeSourcePath}.\n\n${formatParentResult(result)}`,
					display: true,
					details,
				});
				ctx.ui.notify(`Document flow review saved to ${result.reportPath} and inserted into the current session`, "info");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Document flow review failed: ${message}`, "error");
			} finally {
				ctx.ui.setWidget("document-flow-review", undefined);
			}
		},
	});
}
