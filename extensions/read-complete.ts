/**
 * Read Complete Extension
 *
 * Commands:
 *   /read-complete <path>   - Read entire file or directory without truncation, inject into context
 *   /bash-complete <script> - Run bash script, inject full stdout into context (no truncation)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatSize } from "@earendil-works/pi-coding-agent";
import { constants } from "node:fs";
import {
	access as fsAccess,
	lstat as fsLstat,
	readFile as fsReadFile,
	readdir as fsReaddir,
} from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

function cleanInputPath(filePath: string): string {
	return filePath.startsWith("@") ? filePath.slice(1) : filePath;
}

function resolvePath(filePath: string, cwd: string): string {
	const cleaned = cleanInputPath(filePath);
	if (path.isAbsolute(cleaned)) {
		return cleaned;
	}
	return path.resolve(cwd, cleaned);
}

interface FileReadResult {
	path: string;
	content: string;
	lines: number;
	bytes: number;
}

function formatFileContent(filePath: string, textContent: string): FileReadResult {
	const lines = textContent.split("\n").length;
	const bytes = Buffer.byteLength(textContent, "utf-8");
	const header = `Contents of ${filePath} (${lines} lines, ${formatSize(bytes)}):`;
	return { path: filePath, content: `${header}\n\n${textContent}`, lines, bytes };
}

function toDisplayPath(absoluteFilePath: string, rootPath: string, rootInputPath: string): string {
	const cleanedRootInputPath = cleanInputPath(rootInputPath);
	if (path.isAbsolute(cleanedRootInputPath)) {
		return absoluteFilePath;
	}

	const relativeFilePath = path.relative(rootPath, absoluteFilePath);
	return relativeFilePath ? path.join(cleanedRootInputPath, relativeFilePath) : cleanedRootInputPath;
}

async function collectFiles(absolutePath: string): Promise<string[]> {
	const entries = await fsReaddir(absolutePath, { withFileTypes: true });
	const files: string[] = [];

	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		const entryPath = path.join(absolutePath, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await collectFiles(entryPath)));
		} else if (entry.isFile()) {
			files.push(entryPath);
		}
	}

	return files;
}

function runBash(script: string, cwd: string): Promise<{ stdout: string; stderr: string; code: number }> {
	return new Promise((resolve) => {
		const child = spawn("bash", ["-c", script], {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";

		child.stdout.on("data", (data: Buffer) => {
			stdout += data.toString();
		});
		child.stderr.on("data", (data: Buffer) => {
			stderr += data.toString();
		});

		child.on("close", (code) => {
			resolve({ stdout, stderr, code: code ?? 1 });
		});

		child.on("error", (err) => {
			resolve({ stdout, stderr: err.message, code: 1 });
		});
	});
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("read-complete", {
		description: "Read an entire file or directory without truncation limits and inject it into context",
		handler: async (args, ctx) => {
			const filePath = args?.trim();
			if (!filePath) {
				ctx.ui.notify("Usage: /read-complete <path>", "warning");
				return;
			}

			const absolutePath = resolvePath(filePath, ctx.cwd);

			try {
				await fsAccess(absolutePath, constants.R_OK);
			} catch {
				ctx.ui.notify(`Path not found or not readable: ${filePath}`, "error");
				return;
			}

			const stat = await fsLstat(absolutePath);
			if (stat.isDirectory()) {
				const files = await collectFiles(absolutePath);
				const results: FileReadResult[] = [];

				for (const absoluteFilePath of files) {
					const buffer = await fsReadFile(absoluteFilePath);
					const displayPath = toDisplayPath(absoluteFilePath, absolutePath, filePath);
					results.push(formatFileContent(displayPath, buffer.toString("utf-8")));
				}

				const totalLines = results.reduce((sum, result) => sum + result.lines, 0);
				const totalBytes = results.reduce((sum, result) => sum + result.bytes, 0);
				const header = `Contents of directory ${filePath} (${results.length} files, ${totalLines} lines, ${formatSize(totalBytes)}):`;
				const content = `${header}\n\n${results.map((result) => result.content).join("\n\n")}`;

				pi.sendMessage(
					{
						customType: "read-complete",
						content,
						display: true,
						details: {
							path: filePath,
							files: results.map((result) => result.path),
							lines: totalLines,
							bytes: totalBytes,
						},
					},
					{ triggerTurn: false },
				);

				ctx.ui.notify(`Injected ${filePath} (${results.length} files, ${totalLines} lines, ${formatSize(totalBytes)})`, "info");
				return;
			}

			const buffer = await fsReadFile(absolutePath);
			const result = formatFileContent(filePath, buffer.toString("utf-8"));

			pi.sendMessage(
				{
					customType: "read-complete",
					content: result.content,
					display: true,
					details: { path: filePath, lines: result.lines, bytes: result.bytes },
				},
				{ triggerTurn: false },
			);

			ctx.ui.notify(`Injected ${filePath} (${result.lines} lines, ${formatSize(result.bytes)})`, "info");
		},
	});

	pi.registerCommand("bash-complete", {
		description: "Run a bash script and inject full stdout into context (no truncation)",
		handler: async (args, ctx) => {
			const script = args?.trim();
			if (!script) {
				ctx.ui.notify("Usage: /bash-complete <script>", "warning");
				return;
			}

			ctx.ui.notify(`Running: ${script}`, "info");

			const result = await runBash(script, ctx.cwd);
			const output = result.stdout + (result.stderr ? `\n[stderr]\n${result.stderr}` : "");
			const totalLines = output.split("\n").length;
			const totalBytes = Buffer.byteLength(output, "utf-8");

			const exitInfo = result.code !== 0 ? ` (exit code ${result.code})` : "";
			const header = `Output of \`${script}\`${exitInfo} (${totalLines} lines, ${formatSize(totalBytes)}):`;
			const content = `${header}\n\n${output}`;

			pi.sendMessage(
				{
					customType: "bash-complete",
					content,
					display: true,
					details: { script, exitCode: result.code, lines: totalLines, bytes: totalBytes },
				},
				{ triggerTurn: false },
			);

			ctx.ui.notify(`Injected output of \`${script}\`${exitInfo} (${totalLines} lines, ${formatSize(totalBytes)})`, "info");
		},
	});
}
