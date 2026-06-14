import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

const SESSION_ROOT = path.join(process.env.HOME || "/home/claude", ".pi/agent/sessions");

interface PromptHistoryParams {
	date?: string;
	cwdFilter?: string;
	humanOnly?: boolean;
	outDir?: string;
	prefix?: string;
	includeMarkdown?: boolean;
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

interface SessionInfo {
	cwd?: string;
	id?: string;
}

interface UserPromptEntry {
	timestamp: string;
	cwd?: string;
	sessionId?: string;
	sessionPath: string;
	line: number;
	text: string;
	aiToolcallGenerated?: boolean;
	aiToolcallMatches?: ToolStringEntry[];
}

interface ToolStringEntry {
	tool?: string;
	sessionPath: string;
	line: number;
	key: string;
	text: string;
}

interface PromptHistoryResult {
	date: string;
	scannedFiles: number;
	originalCount: number;
	humanCount: number;
	aiToolcallCount: number;
	files: string[];
	cwdCounts: Record<string, number>;
}

function normalizeWhitespace(text: string): string {
	return text.trim().replace(/\s+/g, " ");
}

function todayIsoDate(): string {
	return new Date().toISOString().slice(0, 10);
}

function addDays(date: Date, delta: number): Date {
	const copy = new Date(date.getTime());
	copy.setUTCDate(copy.getUTCDate() + delta);
	return copy;
}

function resolveDate(input?: string): string {
	const trimmed = (input ?? "today").trim().toLowerCase();
	if (!trimmed || trimmed === "today") return todayIsoDate();
	if (trimmed === "yesterday") return addDays(new Date(), -1).toISOString().slice(0, 10);
	if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
	throw new Error(`Invalid date '${input}'. Use YYYY-MM-DD, today, or yesterday.`);
}

function resolveOutDir(cwd: string, outDir?: string): string {
	const dir = outDir?.trim() || "scratch";
	return path.isAbsolute(dir) ? dir : path.resolve(cwd, dir);
}

async function walkJsonlFiles(root: string): Promise<string[]> {
	const result: string[] = [];
	async function walk(dir: string): Promise<void> {
		let entries: Dirent[];
		try {
			entries = await fs.readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				await walk(full);
			} else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
				result.push(full);
			}
		}
	}
	await walk(root);
	result.sort();
	return result;
}

function extractTextContent(content: unknown): string {
	const blocks = Array.isArray(content) ? content : typeof content === "string" ? [content] : [];
	const texts: string[] = [];
	for (const block of blocks) {
		if (typeof block === "string") {
			texts.push(block);
			continue;
		}
		if (!block || typeof block !== "object") continue;
		const obj = block as Record<string, unknown>;
		const type = obj.type;
		if ((type === "text" || type === "input_text") && typeof obj.text === "string") {
			texts.push(obj.text);
		} else if (type === "image" || type === "image_url") {
			texts.push(`[${type}]`);
		} else if (typeof type === "string" && type.length > 0 && type !== "toolResult") {
			texts.push(`[${type}]`);
		}
	}
	return texts.join("\n\n").trim();
}

function* walkStrings(value: unknown, keyPath: string[] = []): Generator<{ key: string; text: string }> {
	if (typeof value === "string") {
		yield { key: keyPath.join("."), text: value };
		return;
	}
	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) {
			yield* walkStrings(value[i], [...keyPath, String(i)]);
		}
		return;
	}
	if (value && typeof value === "object") {
		for (const [key, child] of Object.entries(value as Record<string, Json>)) {
			yield* walkStrings(child, [...keyPath, key]);
		}
	}
}

function relevantToolPromptKey(key: string): boolean {
	const leaf = key.split(".").pop();
	return leaf === "task" || leaf === "prompt" || leaf === "text" || leaf === "command";
}

async function collectPromptHistory(params: PromptHistoryParams, cwd: string): Promise<PromptHistoryResult> {
	const date = resolveDate(params.date);
	const cwdFilter = params.cwdFilter?.trim();
	const outDir = resolveOutDir(cwd, params.outDir);
	const prefix = params.prefix?.trim() || "user-prompts";
	const includeMarkdown = params.includeMarkdown ?? true;
	const humanOnly = params.humanOnly ?? true;

	const allFiles = await walkJsonlFiles(SESSION_ROOT);
	const candidateFiles: string[] = [];
	for (const file of allFiles) {
		const base = path.basename(file);
		if (base.startsWith(date)) {
			candidateFiles.push(file);
			continue;
		}
		try {
			const stat = await fs.stat(file);
			if (stat.mtime.toISOString().slice(0, 10) === date) candidateFiles.push(file);
		} catch {
			// Ignore disappearing session files.
		}
	}

	const prompts: UserPromptEntry[] = [];
	const toolStringsByNormalized = new Map<string, ToolStringEntry[]>();

	for (const sessionPath of candidateFiles) {
		let session: SessionInfo = {};
		let text: string;
		try {
			text = await fs.readFile(sessionPath, "utf8");
		} catch {
			continue;
		}
		const lines = text.split("\n");
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i]?.trim();
			if (!line) continue;
			let obj: Record<string, unknown>;
			try {
				obj = JSON.parse(line) as Record<string, unknown>;
			} catch {
				continue;
			}
			if (obj.type === "session") {
				session = { cwd: typeof obj.cwd === "string" ? obj.cwd : undefined, id: typeof obj.id === "string" ? obj.id : undefined };
				continue;
			}
			if (obj.type !== "message") continue;
			const message = obj.message as Record<string, unknown> | undefined;
			if (!message || typeof message !== "object") continue;
			const timestamp = typeof obj.timestamp === "string" ? obj.timestamp : typeof message.timestamp === "string" ? message.timestamp : "";

			if (message.role === "assistant" && Array.isArray(message.content)) {
				for (const block of message.content) {
					if (!block || typeof block !== "object") continue;
					const toolCall = block as Record<string, unknown>;
					if (toolCall.type !== "toolCall") continue;
					const tool = typeof toolCall.name === "string" ? toolCall.name : undefined;
					for (const item of walkStrings(toolCall.arguments)) {
						if (!relevantToolPromptKey(item.key)) continue;
						const normalized = normalizeWhitespace(item.text);
						if (!normalized) continue;
						const entry: ToolStringEntry = { tool, sessionPath, line: i + 1, key: item.key, text: item.text };
						const list = toolStringsByNormalized.get(normalized);
						if (list) list.push(entry);
						else toolStringsByNormalized.set(normalized, [entry]);
					}
				}
				continue;
			}

			if (message.role !== "user") continue;
			if (!timestamp.startsWith(date)) continue;
			if (cwdFilter && !session.cwd?.includes(cwdFilter)) continue;
			prompts.push({
				timestamp,
				cwd: session.cwd,
				sessionId: session.id,
				sessionPath,
				line: i + 1,
				text: extractTextContent(message.content),
			});
		}
	}

	prompts.sort((a, b) => (a.timestamp || "").localeCompare(b.timestamp || "") || a.sessionPath.localeCompare(b.sessionPath) || a.line - b.line);
	for (const prompt of prompts) {
		const matches = toolStringsByNormalized.get(normalizeWhitespace(prompt.text)) ?? [];
		if (matches.length > 0) {
			prompt.aiToolcallGenerated = true;
			prompt.aiToolcallMatches = matches.slice(0, 5);
		}
	}

	const humanPrompts = prompts.filter((entry) => !entry.aiToolcallGenerated);
	const aiPrompts = prompts.filter((entry) => entry.aiToolcallGenerated);
	const selectedPrompts = humanOnly ? humanPrompts : prompts;

	await fs.mkdir(outDir, { recursive: true });
	const suffixParts = [date];
	if (cwdFilter) suffixParts.push(cwdFilter.replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-|-$/g, ""));
	if (humanOnly) suffixParts.push("human");
	const suffix = suffixParts.filter(Boolean).join("-");
	const jsonlPath = path.join(outDir, `${prefix}-${suffix}.jsonl`);
	const markdownPath = path.join(outDir, `${prefix}-${suffix}.md`);
	const aiJsonlPath = path.join(outDir, `${prefix}-${date}-ai-toolcall-origin.jsonl`);

	await fs.writeFile(jsonlPath, selectedPrompts.map((entry) => JSON.stringify(entry)).join("\n") + (selectedPrompts.length ? "\n" : ""), "utf8");
	await fs.writeFile(aiJsonlPath, aiPrompts.map((entry) => JSON.stringify(entry)).join("\n") + (aiPrompts.length ? "\n" : ""), "utf8");

	const files = [jsonlPath, aiJsonlPath];
	if (includeMarkdown) {
		await fs.writeFile(markdownPath, renderPromptsMarkdown(date, selectedPrompts, prompts.length, humanPrompts.length, aiPrompts.length, humanOnly), "utf8");
		files.push(markdownPath);
		const aiMarkdownPath = path.join(outDir, `${prefix}-${date}-ai-toolcall-origin.md`);
		await fs.writeFile(aiMarkdownPath, renderAiMarkdown(date, aiPrompts), "utf8");
		files.push(aiMarkdownPath);
	}

	const cwdCounts: Record<string, number> = {};
	for (const entry of selectedPrompts) {
		const key = entry.cwd ?? "[unknown]";
		cwdCounts[key] = (cwdCounts[key] ?? 0) + 1;
	}

	return { date, scannedFiles: candidateFiles.length, originalCount: prompts.length, humanCount: humanPrompts.length, aiToolcallCount: aiPrompts.length, files, cwdCounts };
}

function renderPromptsMarkdown(date: string, entries: UserPromptEntry[], originalCount: number, humanCount: number, aiCount: number, humanOnly: boolean): string {
	let out = `# ${humanOnly ? "Human-origin user prompts" : "User prompts"} on ${date}\n\n`;
	out += `Filtered source: \`${SESSION_ROOT}\`\n\n`;
	out += `Original count: ${originalCount}\n\nHuman-origin count: ${humanCount}\n\nAI/toolcall-origin count: ${aiCount}\n\nSelected count: ${entries.length}\n\n`;
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i]!;
		out += `## ${i + 1}. ${entry.timestamp}\n\n- cwd: \`${entry.cwd ?? ""}\`\n- session: \`${entry.sessionPath}:${entry.line}\`\n\n\`\`\`text\n${entry.text.replace(/```/g, "`\u200b``") || "[no text content]"}\n\`\`\`\n\n`;
	}
	return out;
}

function renderAiMarkdown(date: string, entries: UserPromptEntry[]): string {
	let out = `# AI/toolcall-origin prompts on ${date}\n\nCount: ${entries.length}\n\n`;
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i]!;
		const match = entry.aiToolcallMatches?.[0];
		out += `## ${i + 1}. ${entry.timestamp}\n\n- cwd: \`${entry.cwd ?? ""}\`\n- user session: \`${entry.sessionPath}:${entry.line}\`\n`;
		if (match) out += `- matched tool call: \`${match.tool ?? ""}\` \`${match.sessionPath}:${match.line}\` key \`${match.key}\`\n`;
		out += `\n\`\`\`text\n${entry.text.replace(/```/g, "`\u200b``") || "[no text content]"}\n\`\`\`\n\n`;
	}
	return out;
}

function formatResult(result: PromptHistoryResult): string {
	const cwdLines = Object.entries(result.cwdCounts)
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.map(([cwd, count]) => `- ${count} ${cwd}`)
		.join("\n");
	return `prompt-history ${result.date}\n\nScanned files: ${result.scannedFiles}\nOriginal prompts: ${result.originalCount}\nHuman-origin prompts: ${result.humanCount}\nAI/toolcall-origin prompts: ${result.aiToolcallCount}\n\nFiles:\n${result.files.map((file) => `- ${file}`).join("\n")}\n\nSelected prompts by cwd:\n${cwdLines || "- none"}`;
}

function parseCommandArgs(args: string): PromptHistoryParams {
	const params: PromptHistoryParams = {};
	const parts = args.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((part) => part.replace(/^"|"$/g, "")) ?? [];
	for (let i = 0; i < parts.length; i++) {
		const part = parts[i]!;
		if (part === "--all") params.humanOnly = false;
		else if (part === "--human-only") params.humanOnly = true;
		else if (part === "--no-md") params.includeMarkdown = false;
		else if (part === "--cwd") params.cwdFilter = parts[++i];
		else if (part === "--out") params.outDir = parts[++i];
		else if (part === "--prefix") params.prefix = parts[++i];
		else if (!params.date) params.date = part;
	}
	return params;
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("prompt-history", {
		description: "Export pi user prompts. Usage: /prompt-history [today|yesterday|YYYY-MM-DD] [--human-only|--all] [--cwd text] [--out dir]",
		handler: async (args, ctx) => {
			try {
				const result = await collectPromptHistory(parseCommandArgs(args ?? ""), ctx.cwd);
				pi.sendMessage({ customType: "prompt-history", content: formatResult(result), display: true, details: result }, { triggerTurn: false });
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
