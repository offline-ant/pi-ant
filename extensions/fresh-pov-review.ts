import * as path from "node:path";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import {
	runFreshPovReview,
	type FreshPovRunResult,
} from "./fresh-pov-runner.ts";

const ENTRY_TYPE = "fresh-pov-review:result";
const TOOL_NAME = "fresh_pov_review";
const TOOL_STATE_TYPE = "fresh-pov-review:tool-state";

const freshPovToolSchema = Type.Object({
	file: Type.String({
		minLength: 1,
		description: "Document path, resolved relative to the current working directory.",
	}),
	prompt: Type.Optional(Type.String({
		description: "Optional reader profile, audience, or review focus. The isolated reader still receives no project context.",
	})),
});

type FreshPovToolParams = Static<typeof freshPovToolSchema>;

interface ParsedCommand {
	documentPath: string;
	profile?: string;
}

interface ToolState {
	enabled: boolean;
	updatedAt: string;
}

interface ReviewMessageDetails {
	report: string;
	reportPath: string;
	sessionPath: string;
	sourcePath: string;
	unitCount: number;
}

interface FreshPovToolDetails {
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
		throw new Error("Usage: /fresh-pov-review <document-path> [--profile <reader profile>]");
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

function latestToolState(ctx: ExtensionContext): boolean {
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry?.type !== "custom" || entry.customType !== TOOL_STATE_TYPE || !isRecord(entry.data)) continue;
		if (typeof entry.data.enabled === "boolean") return entry.data.enabled;
	}
	return false;
}

function setToolActive(pi: ExtensionAPI, enabled: boolean): void {
	const active = pi.getActiveTools();
	const currentlyActive = active.includes(TOOL_NAME);
	if (enabled && !currentlyActive) {
		pi.setActiveTools([...active, TOOL_NAME]);
	} else if (!enabled && currentlyActive) {
		pi.setActiveTools(active.filter((name) => name !== TOOL_NAME));
	}
}

function formatParentResult(result: FreshPovRunResult): string {
	return [
		result.report,
		"",
		`Report: ${result.reportPath}`,
		`Metadata: ${result.metadataPath}`,
		`Session: ${result.sessionPath}`,
	].join("\n");
}

export default function freshPovReviewExtension(pi: ExtensionAPI): void {
	pi.registerMessageRenderer(ENTRY_TYPE, (message, _options, theme) => {
		const data = reviewMessageDetails(message.details);
		if (!data) return new Text(theme.fg("error", "Fresh POV review result is malformed."), 0, 0);
		const header = theme.fg(
			"accent",
			theme.bold(`Fresh POV review: ${path.basename(data.sourcePath)} (${data.unitCount} reading units)`),
		);
		const paths = theme.fg("dim", `Report: ${data.reportPath}\nSession: ${data.sessionPath}`);
		return new Text(`${header}\n${paths}\n\n${data.report}`, 0, 0);
	});

	pi.registerTool(defineTool<typeof freshPovToolSchema, FreshPovToolDetails>({
			name: TOOL_NAME,
			label: "Fresh POV Review",
			description: "Run an isolated sequential fresh-point-of-view review of one document. Use only after the user explicitly asks for a fresh POV review. Returns the final review and artifact paths.",
			promptSnippet: "Review one document sequentially through an isolated context-free reader",
			promptGuidelines: [
				"Use fresh_pov_review only when the user explicitly requests a fresh-point-of-view document review.",
			],
			parameters: freshPovToolSchema,
			async execute(_toolCallId, params: FreshPovToolParams, signal, onUpdate, ctx) {
				const result = await runFreshPovReview(
					pi,
					ctx,
					{ file: params.file, prompt: params.prompt },
					(text) => onUpdate?.({
						content: [{ type: "text", text }],
						details: { status: "running" } satisfies FreshPovToolDetails,
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
					} satisfies FreshPovToolDetails,
				};
			},
			renderCall(args, theme) {
				return new Text(
					theme.fg("toolTitle", theme.bold("fresh_pov_review ")) + theme.fg("accent", args.file),
					0,
					0,
				);
			},
		}));

	pi.registerCommand("fresh-pov-tool", {
		description: "Enable or disable the agent-callable fresh_pov_review tool: /fresh-pov-tool [on|off|status]",
		getArgumentCompletions: (prefix) => {
			const value = prefix.trim().toLowerCase();
			const matches = ["on", "off", "status"]
				.filter((option) => option.startsWith(value))
				.map((option) => ({ value: option, label: option }));
			return matches.length > 0 ? matches : null;
		},
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			const action = args.trim().toLowerCase() || "status";
			if (action === "status") {
				ctx.ui.notify(`fresh_pov_review tool: ${pi.getActiveTools().includes(TOOL_NAME) ? "on" : "off"}`, "info");
				return;
			}
			if (action !== "on" && action !== "off") {
				ctx.ui.notify("Usage: /fresh-pov-tool [on|off|status]", "warning");
				return;
			}
			const enabled = action === "on";
			pi.appendEntry(TOOL_STATE_TYPE, {
				enabled,
				updatedAt: new Date().toISOString(),
			} satisfies ToolState);
			setToolActive(pi, enabled);
			ctx.ui.notify(`fresh_pov_review tool ${enabled ? "enabled" : "disabled"} for this session`, "info");
		},
	});

	pi.registerCommand("fresh-pov-review", {
		description: "Review a document sequentially in an isolated no-context agent: /fresh-pov-review <path> [--profile <text>]",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			try {
				const parsed = parseCommand(args);
				const result = await runFreshPovReview(
					pi,
					ctx,
					{ file: parsed.documentPath, readerProfile: parsed.profile },
					(text) => ctx.ui.setWidget("fresh-pov-review", text.split("\n")),
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
					content: `An isolated fresh-point-of-view reader reviewed ${relativeSourcePath}.\n\n${formatParentResult(result)}`,
					display: true,
					details,
				});
				ctx.ui.notify(`Fresh POV review saved to ${result.reportPath} and inserted into the current session`, "info");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Fresh POV review failed: ${message}`, "error");
			} finally {
				ctx.ui.setWidget("fresh-pov-review", undefined);
			}
		},
	});

	const refreshToolState = (ctx: ExtensionContext): void => {
		setToolActive(pi, latestToolState(ctx));
	};
	pi.on("session_start", async (_event, ctx) => refreshToolState(ctx));
	pi.on("session_tree", async (_event, ctx) => refreshToolState(ctx));
}
