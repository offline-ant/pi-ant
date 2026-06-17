/**
 * /vim — open conversation transcript in external editor ($VISUAL/$EDITOR/vim).
 * Changed lines are sent as the next user message.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-ai";
import type { TUI } from "@earendil-works/pi-tui";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Transcript builder
// ---------------------------------------------------------------------------

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b): b is { type: string; text: string; data?: string; mimeType?: string } =>
			typeof b === "object" && (b as { type: string }).type === "text" && typeof (b as { text: string }).text === "string")
		.map((b) => b.text)
		.join("\n");
}

function formatTimestamp(ts: number): string {
	return new Date(ts).toISOString().replace("T", " ").slice(0, 19);
}

function formatArgs(args: Record<string, unknown>): string {
	const lines: string[] = [];
	for (const [key, value] of Object.entries(args)) {
		const val = typeof value === "string" ? value : JSON.stringify(value);
		lines.push(`${key}: ${val}`);
	}
	return lines.join("\n") || "(no arguments)";
}

function buildTranscript(messages: AgentMessage[], cwd: string): string {
	const header = [
		`# Pi Session: ${cwd}`,
		"#",
		"# Edit freely. Lines that differ from the original transcript",
		"# will be sent as your next user message.",
		"",
	];

	const lines: string[] = [...header];

	for (const msg of messages) {
		switch (msg.role) {
			case "user": {
				const text = extractText(msg.content);
				if (text) {
					lines.push(`## User (${formatTimestamp(msg.timestamp)})`, text, "");
				}
				break;
			}
			case "assistant": {
				for (const block of msg.content) {
					if (block.type === "text" && block.text.trim()) {
						// Text content appears after tool calls or from pure-text responses
						const existingLast = lines[lines.length - 1];
						if (existingLast === "## Assistant") {
							lines.push(block.text.trim(), "");
						} else {
							lines.push("## Assistant", block.text.trim(), "");
						}
					} else if (block.type === "thinking" && block.thinking.trim()) {
						lines.push("## Thinking", block.thinking.trim(), "");
					} else if (block.type === "toolCall") {
						const args = typeof block.arguments === "object" && block.arguments !== null
							? block.arguments as Record<string, unknown>
							: {};
						lines.push(
							`## Tool: ${block.name}`,
							formatArgs(args),
							"",
						);
					}
				}
				break;
			}
			case "toolResult": {
				const text = extractText(msg.content);
				const label = msg.isError ? " (error)" : "";
				lines.push(`## Tool Result: ${msg.toolName}${label}`, text || "(no output)", "");
				break;
			}
			case "bashExecution": {
				const output = msg.output || "(no output)";
				lines.push("## Bash", `$ ${msg.command}`, output, "");
				break;
			}
			case "custom": {
				if (msg.display) {
					const text = extractText(msg.content);
					lines.push(`## Extension: ${msg.customType}`, text || "(empty)", "");
				}
				break;
			}
			case "compactionSummary": {
				lines.push("## Compaction Summary", msg.summary, "");
				break;
			}
			case "branchSummary": {
				lines.push("## Branch Summary", msg.summary, "");
				break;
			}
		}
	}

	// Strip trailing blank line
	while (lines.length > 0 && lines[lines.length - 1] === "") {
		lines.pop();
	}
	lines.push(""); // single trailing newline

	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

function computeChangedText(original: string, edited: string): string | null {
	if (original === edited) return null;

	const oldLines = original.split("\n");
	const newLines = edited.split("\n");

	// Common prefix
	let prefixLen = 0;
	const minLen = Math.min(oldLines.length, newLines.length);
	while (prefixLen < minLen && oldLines[prefixLen] === newLines[prefixLen]) {
		prefixLen++;
	}

	// Common suffix (excluding prefix)
	let suffixLen = 0;
	while (
		suffixLen < oldLines.length - prefixLen &&
		suffixLen < newLines.length - prefixLen &&
		oldLines[oldLines.length - 1 - suffixLen] === newLines[newLines.length - 1 - suffixLen]
	) {
		suffixLen++;
	}

	const start = prefixLen;
	const end = newLines.length - suffixLen;

	if (start >= end) return null;

	// Trim leading/trailing blank lines from the changed region
	let trimmedStart = start;
	let trimmedEnd = end;
	while (trimmedStart < trimmedEnd && newLines[trimmedStart] === "") trimmedStart++;
	while (trimmedEnd > trimmedStart && newLines[trimmedEnd - 1] === "") trimmedEnd--;

	if (trimmedStart >= trimmedEnd) return null;

	return newLines.slice(trimmedStart, trimmedEnd).join("\n");
}

// ---------------------------------------------------------------------------
// TUI capture
// ---------------------------------------------------------------------------

/** Capture the active TUI instance via a transient custom component. */
function captureTui(ctx: ExtensionCommandContext): Promise<TUI> {
	return ctx.ui.custom<TUI>((tui, _theme, _kb, done) => {
		setImmediate(() => done(tui));
		return {
			render: () => [],
			invalidate: () => {},
			handleInput: () => {},
		};
	});
}

// ---------------------------------------------------------------------------
// Editor launcher
// ---------------------------------------------------------------------------

async function openInEditor(
	tui: TUI,
	transcript: string,
	editorCmd: string,
): Promise<string | null> {
	const tmpFile = path.join(os.tmpdir(), `pi-vim-${Date.now()}.md`);

	try {
		fs.writeFileSync(tmpFile, transcript, "utf-8");
		tui.stop();

		const [editor, ...editorArgs] = editorCmd.split(" ");

		process.stdout.write(`Launching external editor: ${editorCmd}\nPi will resume when the editor exits.\n`);

		const status = await new Promise<number | null>((resolve) => {
			const child = spawn(editor, [...editorArgs, tmpFile], {
				stdio: "inherit",
				shell: process.platform === "win32",
			});
			child.on("error", () => resolve(null));
			child.on("close", (code) => resolve(code));
		});

		if (status !== 0) return null;

		// Read and normalize: strip trailing newline added by editors, but keep
		// intentional trailing newlines indicated by a final blank line.
		const edited = fs.readFileSync(tmpFile, "utf-8").replace(/\n$/, "");
		return edited;
	} finally {
		// Always restart TUI and clean up, even on error
		tui.start();
		tui.requestRender(true);
		try {
			fs.unlinkSync(tmpFile);
		} catch {
			// best-effort cleanup
		}
	}
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	pi.registerCommand("vim", {
		description: "Open conversation in external editor and send edited text as next message",
		handler: async (_args, ctx) => {
			// Don't snapshot while streaming
			await ctx.waitForIdle();

			const editorCmd = process.env.VISUAL || process.env.EDITOR || "vim";

			// Build transcript from the current conversation branch
			const context = ctx.sessionManager.buildSessionContext();
			const transcript = buildTranscript(context.messages, ctx.cwd);

			// Capture TUI, stop it, spawn editor, restart, diff, send
			let tui: TUI;
			try {
				tui = await captureTui(ctx);
			} catch {
				ctx.ui.notify("/vim: failed to access terminal UI", "error");
				return;
			}

			const edited = await openInEditor(tui, transcript, editorCmd);

			if (edited === null) {
				ctx.ui.notify("Editor exited with error status", "info");
				return;
			}

			const changed = computeChangedText(transcript, edited);

			if (!changed) {
				ctx.ui.notify("No changes detected", "info");
				return;
			}

			// Send as a real user message, triggering a turn
			pi.sendUserMessage(changed);

			const preview =
				changed.length <= 120
					? changed.replace(/\n/g, "\\n")
					: changed.slice(0, 117).replace(/\n/g, "\\n") + "...";
			ctx.ui.notify(`Sent ${changed.split("\n").length} lines: ${preview}`, "info");
		},
	});
}
