import {
	type Api,
	type Context,
	completeSimple,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
	buildSessionContext,
	type ContextEvent,
	type ExtensionAPI,
	type ExtensionCommandContext,
	estimateTokens,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";

type AgentMessage = ContextEvent["messages"][number];

const CHECKPOINT_TYPE = "pi-reflect:checkpoint";
const CHECKPOINT_VERSION = 1;
const MAX_BLOCK_CONTENT_CHARS = 4000;
const MAX_PREVIEW_CHARS = 140;

const REFLECTION_SYSTEM_PROMPT =
	"You help rewrite an agent's memory checkpoint. Be conservative, factual, and preserve operationally important details.";

const REFLECTION_PROMPT = `You are reflecting on the agent memory below. The memory is represented as numbered blocks in chronological order.

Task:
1. Return machine-readable memory edit commands in <commands> tags.
2. Return a replacement memory checkpoint summary in <summary> tags.

Command syntax:
- drop <number>
- replace <number>: <replacement text>
- none

Rules:
- Use drop only for obsolete, misleading, duplicated, or harmful memory.
- Use replace only when a block is materially wrong or should be shortened/corrected.
- Avoid editing early-numbered blocks unless they are clearly wrong; prefer preserving stable early memory.
- The <summary> is authoritative. A replace command only matters if its replacement is incorporated into <summary>.
- The summary must incorporate all kept blocks plus replacements and exclude dropped blocks.
- Preserve exact file paths, commands, constraints, user preferences, decisions, and next steps.
- Do not mention block numbers in the summary unless the number itself matters.
- If no edits are needed, use "none" in <commands> and still provide a concise current memory summary.

Use this exact response shape:
<commands>
none
</commands>
<summary>
## Goal
...

## Constraints & Preferences
- ...

## Progress
### Done
- ...

### In Progress
- ...

### Blocked
- ...

## Key Decisions
- ...

## Next Steps
1. ...

## Critical Context
- ...
</summary>`;

type TextishContent =
	| string
	| Array<{ type: string; text?: string; mimeType?: string }>;

type ReflectionCommand =
	| { action: "drop"; block: number; raw: string }
	| { action: "replace"; block: number; replacement: string; raw: string };

interface ReflectionBlock {
	index: number;
	kind: string;
	preview: string;
	content: string;
	truncated: boolean;
}

interface ReflectionPlan {
	summary: string;
	commandsText: string;
	commands: ReflectionCommand[];
	blocks: ReflectionBlock[];
	tokensBefore: number;
	customInstructions?: string;
	sourceLeafId: string | null;
}

interface ReflectCheckpoint {
	version: typeof CHECKPOINT_VERSION;
	summary: string;
	commandsText: string;
	commands: ReflectionCommand[];
	blockCount: number;
	tokensBefore: number;
	customInstructions?: string;
	sourceLeafId: string | null;
	timestamp: number;
}

type CheckpointEntry = Extract<SessionEntry, { type: "custom" }> & {
	customType: typeof CHECKPOINT_TYPE;
	data: ReflectCheckpoint;
};

function truncateText(
	text: string,
	maxChars: number,
): { text: string; truncated: boolean } {
	if (text.length <= maxChars) {
		return { text, truncated: false };
	}
	const omitted = text.length - maxChars;
	return {
		text: `${text.slice(0, maxChars)}\n[truncated ${omitted} chars]`,
		truncated: true,
	};
}

function normalizeWhitespace(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function previewText(text: string): string {
	const normalized = normalizeWhitespace(text);
	if (normalized.length <= MAX_PREVIEW_CHARS) {
		return normalized || "(empty)";
	}
	const sentenceEnd = normalized.search(/[.!?](?:\s|$)/);
	if (sentenceEnd >= 20 && sentenceEnd + 1 <= MAX_PREVIEW_CHARS) {
		return normalized.slice(0, sentenceEnd + 1);
	}
	return `${normalized.slice(0, MAX_PREVIEW_CHARS - 1)}…`;
}

function stringifyContent(content: TextishContent): string {
	if (typeof content === "string") {
		return content;
	}

	const parts: string[] = [];
	for (const block of content) {
		if (block.type === "text") {
			parts.push(block.text ?? "");
		} else if (block.type === "image") {
			parts.push(`[image: ${block.mimeType ?? "unknown"}]`);
		}
	}
	return parts.join("\n");
}

function addBlock(
	blocks: ReflectionBlock[],
	kind: string,
	content: string,
): void {
	const truncated = truncateText(content, MAX_BLOCK_CONTENT_CHARS);
	blocks.push({
		index: blocks.length + 1,
		kind,
		preview: previewText(content),
		content: truncated.text,
		truncated: truncated.truncated,
	});
}

function createReflectionBlocks(messages: AgentMessage[]): ReflectionBlock[] {
	const blocks: ReflectionBlock[] = [];

	for (const message of messages) {
		switch (message.role) {
			case "user":
				addBlock(blocks, "user text", stringifyContent(message.content));
				break;
			case "assistant":
				for (const content of message.content) {
					if (content.type === "text") {
						addBlock(blocks, "assistant reply", content.text);
					} else if (content.type === "thinking") {
						addBlock(blocks, "assistant thinking", content.thinking);
					} else if (content.type === "toolCall") {
						addBlock(
							blocks,
							`tool call: ${content.name}`,
							JSON.stringify(content.arguments, null, 2),
						);
					}
				}
				break;
			case "toolResult":
				addBlock(
					blocks,
					`tool result: ${message.toolName}`,
					stringifyContent(message.content),
				);
				break;
			case "bashExecution": {
				const output = message.output
					? `\nOutput:\n${message.output}`
					: "\nOutput: (no output)";
				addBlock(
					blocks,
					"bash execution",
					`Command:\n${message.command}${output}`,
				);
				break;
			}
			case "custom":
				addBlock(
					blocks,
					`custom message: ${message.customType}`,
					stringifyContent(message.content),
				);
				break;
			case "branchSummary":
				addBlock(blocks, "branch summary", message.summary);
				break;
			case "compactionSummary":
				addBlock(blocks, "compaction summary", message.summary);
				break;
			default: {
				const exhaustive: never = message;
				return exhaustive;
			}
		}
	}

	return blocks;
}

function formatBlocksForPrompt(blocks: ReflectionBlock[]): string {
	return blocks
		.map((block) => {
			const truncated = block.truncated ? " (content truncated)" : "";
			return `[${block.index}] ${block.kind}${truncated}\nPreview: ${block.preview}\nContent:\n${block.content}`;
		})
		.join("\n\n---\n\n");
}

function extractTagged(
	text: string,
	tag: "commands" | "summary",
): string | undefined {
	const pattern = new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`, "i");
	const match = text.match(pattern);
	return match?.[1]?.trim();
}

function parseReflectionCommands(commandsText: string): ReflectionCommand[] {
	const commands: ReflectionCommand[] = [];
	for (const line of commandsText.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.toLowerCase() === "none") {
			continue;
		}

		const dropMatch = trimmed.match(/^drop\s+(\d+)\s*$/i);
		if (dropMatch) {
			commands.push({
				action: "drop",
				block: Number(dropMatch[1]),
				raw: trimmed,
			});
			continue;
		}

		const replaceMatch = trimmed.match(/^replace\s+(\d+)\s*:?\s+([\s\S]+)$/i);
		if (replaceMatch) {
			commands.push({
				action: "replace",
				block: Number(replaceMatch[1]),
				replacement: replaceMatch[2].trim(),
				raw: trimmed,
			});
		}
	}
	return commands;
}

function formatCheckpointForContext(checkpoint: ReflectCheckpoint): string {
	const commands = checkpoint.commandsText.trim() || "none";
	return `The conversation history before this point was reflected into the following memory checkpoint. Use it as the authoritative replacement for prior history.\n\n<reflection-commands>\n${commands}\n</reflection-commands>\n\n<reflection-summary>\n${checkpoint.summary}\n</reflection-summary>`;
}

function createCheckpointMessage(checkpoint: ReflectCheckpoint): AgentMessage {
	return {
		role: "custom",
		customType: CHECKPOINT_TYPE,
		content: formatCheckpointForContext(checkpoint),
		display: false,
		details: { version: checkpoint.version, blockCount: checkpoint.blockCount },
		timestamp: checkpoint.timestamp,
	};
}

function entryToMessage(entry: SessionEntry): AgentMessage | undefined {
	switch (entry.type) {
		case "message":
			return entry.message;
		case "custom_message":
			return {
				role: "custom",
				customType: entry.customType,
				content: entry.content,
				display: entry.display,
				details: entry.details,
				timestamp: new Date(entry.timestamp).getTime(),
			};
		case "branch_summary":
			return {
				role: "branchSummary",
				summary: entry.summary,
				fromId: entry.fromId,
				timestamp: new Date(entry.timestamp).getTime(),
			};
		case "compaction":
			return {
				role: "compactionSummary",
				summary: entry.summary,
				tokensBefore: entry.tokensBefore,
				timestamp: new Date(entry.timestamp).getTime(),
			};
		case "custom":
		case "label":
		case "model_change":
		case "session_info":
		case "thinking_level_change":
			return undefined;
	}
}

function isCheckpointEntry(entry: SessionEntry): entry is CheckpointEntry {
	return (
		entry.type === "custom" &&
		entry.customType === CHECKPOINT_TYPE &&
		isCheckpointData(entry.data)
	);
}

function isCheckpointData(value: unknown): value is ReflectCheckpoint {
	if (!value || typeof value !== "object") {
		return false;
	}
	const data = value as Partial<ReflectCheckpoint>;
	return (
		data.version === CHECKPOINT_VERSION && typeof data.summary === "string"
	);
}

function findLatestCheckpoint(
	branch: SessionEntry[],
): { entry: CheckpointEntry; index: number } | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (isCheckpointEntry(entry)) {
			return { entry, index: i };
		}
	}
	return undefined;
}

function getVisibleMessages(ctx: ExtensionCommandContext): AgentMessage[] {
	const branch = ctx.sessionManager.getBranch();
	const checkpoint = findLatestCheckpoint(branch);
	if (!checkpoint) {
		return buildSessionContext(
			ctx.sessionManager.getEntries(),
			ctx.sessionManager.getLeafId(),
		).messages;
	}

	const messages: AgentMessage[] = [
		createCheckpointMessage(checkpoint.entry.data),
	];
	for (const entry of branch.slice(checkpoint.index + 1)) {
		const message = entryToMessage(entry);
		if (message) {
			messages.push(message);
		}
	}
	return messages;
}

function createReflectionOptions(
	model: Model<Api>,
	apiKey: string | undefined,
	headers: Record<string, string> | undefined,
	thinkingLevel: ReturnType<ExtensionAPI["getThinkingLevel"]>,
): SimpleStreamOptions {
	const maxTokens = Math.min(
		12000,
		model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
	);
	const options: SimpleStreamOptions = { maxTokens, apiKey, headers };
	if (model.reasoning && thinkingLevel !== "off") {
		options.reasoning = thinkingLevel;
	}
	return options;
}

async function generateReflectionPlan(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	customInstructions?: string,
): Promise<ReflectionPlan> {
	const model = ctx.model;
	if (!model) {
		throw new Error("No model selected");
	}

	const messages = getVisibleMessages(ctx);
	const blocks = createReflectionBlocks(messages);
	if (blocks.length === 0) {
		throw new Error("Nothing to reflect (no context blocks)");
	}

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) {
		throw new Error(auth.error);
	}

	let promptText = `${REFLECTION_PROMPT}\n\n<blocks>\n${formatBlocksForPrompt(blocks)}\n</blocks>`;
	if (customInstructions) {
		promptText += `\n\nAdditional reflection focus:\n${customInstructions}`;
	}

	const response = await completeSimple(
		model,
		{
			systemPrompt: REFLECTION_SYSTEM_PROMPT,
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: promptText }],
					timestamp: Date.now(),
				},
			],
		} satisfies Context,
		createReflectionOptions(
			model,
			auth.apiKey,
			auth.headers,
			pi.getThinkingLevel(),
		),
	);

	if (response.stopReason === "error") {
		throw new Error(
			`Reflection failed: ${response.errorMessage || "Unknown error"}`,
		);
	}

	const responseText = response.content
		.filter(
			(content): content is { type: "text"; text: string } =>
				content.type === "text",
		)
		.map((content) => content.text)
		.join("\n")
		.trim();
	const commandsText = extractTagged(responseText, "commands") ?? "none";
	const summary = extractTagged(responseText, "summary") ?? responseText;
	if (!summary.trim()) {
		throw new Error("Reflection failed: model returned an empty summary");
	}

	return {
		summary: summary.trim(),
		commandsText,
		commands: parseReflectionCommands(commandsText),
		blocks,
		tokensBefore: messages.reduce(
			(total, message) => total + estimateTokens(message),
			0,
		),
		customInstructions,
		sourceLeafId: ctx.sessionManager.getLeafId(),
	};
}

function formatPlanForReview(plan: ReflectionPlan): string {
	const blockPreview = plan.blocks.map(
		(block) => `${block.index}. ${block.kind} — ${block.preview}`,
	);
	return [
		"# Reflection proposal",
		"",
		`Blocks reviewed: ${plan.blocks.length}`,
		`Commands proposed: ${plan.commands.length}`,
		"",
		"## Blocks",
		...blockPreview,
		"",
		"<commands>",
		plan.commandsText.trim() || "none",
		"</commands>",
		"",
		"<summary>",
		plan.summary,
		"</summary>",
	].join("\n");
}

function planFromReview(
	original: ReflectionPlan,
	reviewedText: string,
): ReflectionPlan {
	const commandsText =
		extractTagged(reviewedText, "commands") ?? original.commandsText;
	const summary = extractTagged(reviewedText, "summary") ?? original.summary;
	return {
		...original,
		commandsText,
		commands: parseReflectionCommands(commandsText),
		summary: summary.trim(),
	};
}

function applyPlan(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	plan: ReflectionPlan,
): void {
	const currentLeafId = ctx.sessionManager.getLeafId();
	if (plan.sourceLeafId !== currentLeafId) {
		throw new Error(
			"Cannot apply reflection: session changed since the plan was generated",
		);
	}

	const checkpoint: ReflectCheckpoint = {
		version: CHECKPOINT_VERSION,
		summary: plan.summary,
		commandsText: plan.commandsText,
		commands: plan.commands,
		blockCount: plan.blocks.length,
		tokensBefore: plan.tokensBefore,
		customInstructions: plan.customInstructions,
		sourceLeafId: plan.sourceLeafId,
		timestamp: Date.now(),
	};
	pi.appendEntry(CHECKPOINT_TYPE, checkpoint);
}

export default function reflectExtension(pi: ExtensionAPI): void {
	pi.registerCommand("reflect", {
		description: "Review and rewrite memory with an append-only checkpoint",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();

			const customInstructions = args.trim() || undefined;
			const plan = await generateReflectionPlan(pi, ctx, customInstructions);

			if (!ctx.hasUI) {
				throw new Error("/reflect requires UI confirmation before applying");
			}

			const reviewed = await ctx.ui.editor(
				"Review reflection proposal",
				formatPlanForReview(plan),
			);
			if (reviewed === undefined) {
				ctx.ui.notify("Reflection cancelled", "info");
				return;
			}

			const reviewedPlan = planFromReview(plan, reviewed);
			if (!reviewedPlan.summary.trim()) {
				throw new Error("Reflection summary cannot be empty");
			}

			const confirmed = await ctx.ui.confirm(
				"Apply reflection?",
				"This appends a memory checkpoint and future model calls will use it as the replacement for prior context.",
			);
			if (!confirmed) {
				ctx.ui.notify("Reflection cancelled", "info");
				return;
			}

			applyPlan(pi, ctx, reviewedPlan);
			ctx.ui.notify(
				`Reflection checkpoint applied (${reviewedPlan.blocks.length} blocks, ${reviewedPlan.commands.length} commands).`,
				"info",
			);
		},
	});

	pi.on("context", (_event, ctx) => {
		const branch = ctx.sessionManager.getBranch();
		const checkpoint = findLatestCheckpoint(branch);
		if (!checkpoint) {
			return undefined;
		}

		const messages: AgentMessage[] = [
			createCheckpointMessage(checkpoint.entry.data),
		];
		for (const entry of branch.slice(checkpoint.index + 1)) {
			const message = entryToMessage(entry);
			if (message) {
				messages.push(message);
			}
		}

		return { messages };
	});
}
