/**
 * Save Conversation Extension
 *
 * Exports the current conversation branch as a markdown file with truncated
 * tool outputs that match the TUI collapsed display. Truncated sections are
 * clearly marked.
 *
 * Commands:
 *   /save-conversation [path]  - Save conversation to a file (default: conversation.md)
 *
 * Usage:
 *   pi -e ./extensions/save-conversation.ts
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

// Match the TUI collapsed preview limits from tool-execution.ts
const TOOL_PREVIEW: Record<string, { lines: number; fromEnd: boolean }> = {
	bash: { lines: 5, fromEnd: true },
	read: { lines: 10, fromEnd: false },
	write: { lines: 10, fromEnd: false },
	edit: { lines: 0, fromEnd: false }, // edit shows diff, handled separately
	ls: { lines: 20, fromEnd: false },
	find: { lines: 20, fromEnd: false },
	grep: { lines: 15, fromEnd: false },
};

const DEFAULT_PREVIEW = { lines: 10, fromEnd: false };

// --- Text helpers ---

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b: any) => b && typeof b === "object" && b.type === "text" && typeof b.text === "string")
		.map((b: any) => b.text)
		.join("");
}

function extractToolCalls(content: unknown): Array<{ name: string; args: Record<string, any> }> {
	if (!Array.isArray(content)) return [];
	return content
		.filter((b: any) => b && typeof b === "object" && b.type === "toolCall" && typeof b.name === "string")
		.map((b: any) => ({ name: b.name, args: b.arguments ?? {} }));
}

function shortenPath(filePath: string): string {
	const home = homedir();
	if (filePath.startsWith(home)) return `~${filePath.slice(home.length)}`;
	return filePath;
}

// --- Truncation ---

function truncateLines(text: string, max: number, fromEnd: boolean): { text: string; truncated: boolean; total: number; shown: number } {
	const lines = text.split("\n");
	if (lines.length <= max) return { text, truncated: false, total: lines.length, shown: lines.length };

	if (fromEnd) {
		const shown = lines.slice(-max);
		return {
			text: shown.join("\n"),
			truncated: true,
			total: lines.length,
			shown: max,
		};
	}
	const shown = lines.slice(0, max);
	return {
		text: shown.join("\n"),
		truncated: true,
		total: lines.length,
		shown: max,
	};
}

// --- Tool call formatting ---

function formatToolCallHeader(name: string, args: Record<string, any>): string {
	switch (name) {
		case "bash": {
			const cmd = typeof args.command === "string" ? args.command : "...";
			const timeout = typeof args.timeout === "number" ? ` (timeout ${args.timeout}s)` : "";
			return `**$ ${cmd}**${timeout}`;
		}
		case "read": {
			const path = typeof (args.file_path ?? args.path) === "string" ? shortenPath(args.file_path ?? args.path) : "...";
			let range = "";
			if (args.offset !== undefined || args.limit !== undefined) {
				const start = args.offset ?? 1;
				const end = args.limit !== undefined ? start + args.limit - 1 : "";
				range = `:${start}${end ? `-${end}` : ""}`;
			}
			return `**read** ${path}${range}`;
		}
		case "write": {
			const path = typeof (args.file_path ?? args.path) === "string" ? shortenPath(args.file_path ?? args.path) : "...";
			return `**write** ${path}`;
		}
		case "edit": {
			const path = typeof (args.file_path ?? args.path) === "string" ? shortenPath(args.file_path ?? args.path) : "...";
			return `**edit** ${path}`;
		}
		case "ls": {
			const path = typeof args.path === "string" ? shortenPath(args.path || ".") : ".";
			const limit = typeof args.limit === "number" ? ` (limit ${args.limit})` : "";
			return `**ls** ${path}${limit}`;
		}
		case "find": {
			const pattern = typeof args.pattern === "string" ? args.pattern : "";
			const path = typeof args.path === "string" ? shortenPath(args.path || ".") : ".";
			const limit = typeof args.limit === "number" ? ` (limit ${args.limit})` : "";
			return `**find** ${pattern} in ${path}${limit}`;
		}
		case "grep": {
			const pattern = typeof args.pattern === "string" ? `/${args.pattern}/` : "";
			const path = typeof args.path === "string" ? shortenPath(args.path || ".") : ".";
			const glob = typeof args.glob === "string" ? ` (${args.glob})` : "";
			const limit = typeof args.limit === "number" ? ` limit ${args.limit}` : "";
			return `**grep** ${pattern} in ${path}${glob}${limit}`;
		}
		default:
			return `**${name}**`;
	}
}

// --- Edit tool: inline diff from oldText/newText ---

function formatEditDiff(args: Record<string, any>): string | null {
	const oldText = typeof args.oldText === "string" ? args.oldText : null;
	const newText = typeof args.newText === "string" ? args.newText : null;
	if (oldText === null || newText === null) return null;

	const oldLines = oldText.split("\n");
	const newLines = newText.split("\n");
	const diffLines: string[] = [];
	for (const line of oldLines) diffLines.push(`- ${line}`);
	for (const line of newLines) diffLines.push(`+ ${line}`);
	return diffLines.join("\n");
}

// --- Result formatting ---

function formatToolResult(toolName: string, args: Record<string, any>, content: unknown, isError: boolean, details: any): string {
	const output = extractText(content).trim();

	if (isError) {
		if (!output) return "> **Error**";
		return `> **Error:**\n\`\`\`\n${output}\n\`\`\``;
	}

	// Edit tool: show diff instead of raw output
	if (toolName === "edit") {
		// Prefer the diff from details (computed by the tool)
		if (details?.diff) {
			return `\`\`\`diff\n${details.diff}\n\`\`\``;
		}
		// Fall back to computing from args
		const diff = formatEditDiff(args);
		if (diff) return `\`\`\`diff\n${diff}\n\`\`\``;
		if (output) return `\`\`\`\n${output}\n\`\`\``;
		return "";
	}

	// Write tool: show the content being written, not the result
	if (toolName === "write") {
		const fileContent = typeof args.content === "string" ? args.content : null;
		if (fileContent) {
			const preview = TOOL_PREVIEW.write;
			const result = truncateLines(fileContent, preview.lines, preview.fromEnd);
			let block = `\`\`\`\n${result.text}\n\`\`\``;
			if (result.truncated) {
				block += `\n> *... ${result.total - result.shown} more lines, ${result.total} total (truncated)*`;
			}
			return block;
		}
		if (output) return `\`\`\`\n${output}\n\`\`\``;
		return "";
	}

	if (!output) return "";

	const preview = TOOL_PREVIEW[toolName] ?? DEFAULT_PREVIEW;
	const result = truncateLines(output, preview.lines, preview.fromEnd);

	let block = `\`\`\`\n${result.text}\n\`\`\``;
	if (result.truncated) {
		if (preview.fromEnd) {
			block = `> *... ${result.total - result.shown} earlier lines (truncated)*\n` + block;
		} else {
			block += `\n> *... ${result.total - result.shown} more lines, ${result.total} total (truncated)*`;
		}
	}

	return block;
}

// --- Conversation builder ---

interface SessionEntry {
	type: string;
	message?: {
		role?: string;
		content?: unknown;
		model?: string;
		provider?: string;
		usage?: { cost?: { total?: number }; totalTokens?: number };
		toolCallId?: string;
		toolName?: string;
		isError?: boolean;
		details?: any;
		timestamp?: number;
		stopReason?: string;
	};
}

function formatConversation(entries: SessionEntry[]): string {
	const parts: string[] = [];

	// Track tool call args so we can pair them with results
	const toolCallArgs = new Map<string, { name: string; args: Record<string, any> }>();

	for (const entry of entries) {
		if (entry.type !== "message" || !entry.message) continue;
		const msg = entry.message;

		switch (msg.role) {
			case "user": {
				const text = extractText(msg.content).trim();
				if (text) parts.push(`## User\n\n${text}`);
				break;
			}

			case "assistant": {
				const text = extractText(msg.content).trim();
				const toolCalls = extractToolCalls(msg.content);

				// Index tool call args for pairing with results
				for (const tc of toolCalls) {
					const id = (msg.content as any[])?.find(
						(b: any) => b.type === "toolCall" && b.name === tc.name && b.arguments === tc.args,
					)?.id;
					if (id) toolCallArgs.set(id, tc);
				}

				let section = "## Assistant\n\n";
				if (text) section += text + "\n";

				for (const tc of toolCalls) {
					section += "\n" + formatToolCallHeader(tc.name, tc.args) + "\n";
				}

				parts.push(section.trimEnd());
				break;
			}

			case "toolResult": {
				const toolCallId = msg.toolCallId ?? "";
				const toolName = msg.toolName ?? "";
				const isError = msg.isError ?? false;

				const tc = toolCallArgs.get(toolCallId);
				const args = tc?.args ?? {};

				const result = formatToolResult(toolName, args, msg.content, isError, msg.details);
				if (result) parts.push(result);
				break;
			}

			case "bashExecution": {
				// User ! commands
				const m = msg as any;
				const cmd = m.command ?? "";
				const output = (m.output ?? "").trim();
				let section = `## User (shell)\n\n\`\`\`\n$ ${cmd}\n`;
				if (output) {
					const result = truncateLines(output, 5, true);
					if (result.truncated) {
						section += `\n... ${result.total - result.shown} earlier lines (truncated)\n\n`;
					}
					section += result.text + "\n";
				}
				section += "```";
				parts.push(section);
				break;
			}

			case "compactionSummary": {
				const m = msg as any;
				parts.push(`---\n\n*Context compacted (${m.tokensBefore?.toLocaleString() ?? "?"} tokens before). Summary:*\n\n${m.summary ?? ""}`);
				break;
			}

			case "branchSummary": {
				const m = msg as any;
				parts.push(`---\n\n*Branch summary:*\n\n${m.summary ?? ""}`);
				break;
			}

			case "custom": {
				const m = msg as any;
				if (m.display !== false) {
					const text = extractText(m.content).trim();
					if (text) parts.push(`> **[${m.customType ?? "extension"}]** ${text}`);
				}
				break;
			}
		}
	}

	return parts.join("\n\n") + "\n";
}

// --- Extension ---

function saveConversation(entries: SessionEntry[], outputPath: string, cwd: string): { resolved: string; entryCount: number } {
	const resolved = resolve(cwd, outputPath);
	const md = formatConversation(entries);
	writeFileSync(resolved, md);
	const messageCount = entries.filter((e) => e.type === "message" && e.message?.role === "user").length;
	return { resolved, entryCount: messageCount };
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("save-conversation", {
		description: "Save conversation as markdown (truncated like TUI display)",
		handler: async (args, ctx) => {
			const outputPath = args?.trim() || "conversation.md";
			const branch = ctx.sessionManager.getBranch();
			const { resolved, entryCount } = saveConversation(branch, outputPath, ctx.cwd);
			ctx.ui.notify(`Saved ${entryCount} messages to ${resolved}`, "info");
		},
	});
}
