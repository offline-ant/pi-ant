import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateTail,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { spawn } from "node:child_process";
import path from "node:path";
import { Type, type Static } from "typebox";

const BROWSER_IO_SCRIPT = path.resolve(__dirname, "../bin/browser-io");

const BROWSER_PARAMS = Type.Object({
	session_id: Type.Optional(Type.String({ description: "Browser session id. Defaults to 'default'." })),
	browser: Type.Optional(StringEnum(["chromium", "firefox"] as const, { description: "Browser engine. Defaults to chromium." })),
	url: Type.Optional(Type.String({ description: "URL to navigate to before screenshots/eval." })),
	eval: Type.Optional(Type.String({ description: "JavaScript expression to evaluate after the first screenshot. Promise results are awaited." })),
});

type BrowserParams = Static<typeof BROWSER_PARAMS>;

type BrowserName = "chromium" | "firefox";

interface BrowserResult {
	session_id: string;
	browser: BrowserName;
	url: string | null;
	title: string | null;
	before_screenshot: string;
	before_html: string;
	after_screenshot: string;
	after_html: string;
	before_html_error?: string;
	after_html_error?: string;
	eval_result?: unknown;
	eval_error?: string;
}

interface CommandResult {
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" ? value : undefined;
}

function parseBrowserResult(stdout: string): BrowserResult {
	const parsed = JSON.parse(stdout) as unknown;
	const envelope = asRecord(parsed);
	if (!envelope) throw new Error("browser-io returned non-object JSON");

	if (envelope.ok !== true) {
		const message = readString(envelope, "error") ?? "browser-io failed";
		throw new Error(message);
	}

	const result = asRecord(envelope.result);
	if (!result) throw new Error("browser-io returned no result object");

	const sessionId = readString(result, "session_id");
	const browser = readString(result, "browser");
	const beforeScreenshot = readString(result, "before_screenshot");
	const beforeHtml = readString(result, "before_html");
	const afterScreenshot = readString(result, "after_screenshot");
	const afterHtml = readString(result, "after_html");
	if (!sessionId || (browser !== "chromium" && browser !== "firefox") || !beforeScreenshot || !beforeHtml || !afterScreenshot || !afterHtml) {
		throw new Error("browser-io returned an invalid result object");
	}

	const url = result.url === null ? null : readString(result, "url") ?? null;
	const title = result.title === null ? null : readString(result, "title") ?? null;
	const browserResult: BrowserResult = {
		session_id: sessionId,
		browser,
		url,
		title,
		before_screenshot: beforeScreenshot,
		before_html: beforeHtml,
		after_screenshot: afterScreenshot,
		after_html: afterHtml,
	};

	const beforeHtmlError = readString(result, "before_html_error");
	if (beforeHtmlError) browserResult.before_html_error = beforeHtmlError;
	const afterHtmlError = readString(result, "after_html_error");
	if (afterHtmlError) browserResult.after_html_error = afterHtmlError;
	if ("eval_result" in result) browserResult.eval_result = result.eval_result;
	const evalError = readString(result, "eval_error");
	if (evalError) browserResult.eval_error = evalError;
	return browserResult;
}

function runBrowserIo(params: BrowserParams, signal?: AbortSignal): Promise<CommandResult> {
	return new Promise((resolve) => {
		const child = spawn(BROWSER_IO_SCRIPT, [], {
			stdio: ["pipe", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		let settled = false;
		let killed = false;

		const timeout = setTimeout(() => {
			killed = true;
			child.kill("SIGTERM");
		}, 60_000);

		const abort = () => {
			killed = true;
			child.kill("SIGTERM");
		};

		if (signal) {
			if (signal.aborted) abort();
			signal.addEventListener("abort", abort, { once: true });
		}

		child.stdout.on("data", (data: Buffer) => {
			stdout += data.toString();
		});

		child.stderr.on("data", (data: Buffer) => {
			stderr += data.toString();
		});

		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			signal?.removeEventListener("abort", abort);
			resolve({ stdout, stderr: stderr ? `${stderr}\n${error.message}` : error.message, code: 1, killed });
		});

		child.on("close", (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			signal?.removeEventListener("abort", abort);
			resolve({ stdout, stderr, code: code ?? 1, killed });
		});

		child.stdin.end(JSON.stringify(params));
	});
}

function formatValue(value: unknown): string {
	if (value === undefined) return "undefined";
	if (typeof value === "string") return value;
	const json = JSON.stringify(value, null, 2);
	return json ?? String(value);
}

function truncateText(text: string): { text: string; truncated: boolean } {
	const truncation = truncateTail(text, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});
	let content = truncation.content;
	if (truncation.truncated) {
		content += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`;
		content += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).]`;
	}
	return { text: content, truncated: truncation.truncated };
}

function formatBrowserResult(result: BrowserResult): string {
	const lines = [
		`session_id: ${result.session_id}`,
		`browser: ${result.browser}`,
		`url: ${result.url ?? ""}`,
		`title: ${result.title ?? ""}`,
		`before_screenshot: ${result.before_screenshot}`,
		`before_html: ${result.before_html}`,
		`after_screenshot: ${result.after_screenshot}`,
		`after_html: ${result.after_html}`,
	];

	if (result.before_html_error) {
		lines.push("", "before_html_error:", result.before_html_error);
	}
	if (result.after_html_error) {
		lines.push("", "after_html_error:", result.after_html_error);
	}
	if ("eval_result" in result) {
		lines.push("", "eval_result:", formatValue(result.eval_result));
	}
	if (result.eval_error) {
		lines.push("", "eval_error:", result.eval_error);
	}

	return lines.join("\n");
}

function formatFailure(result: CommandResult): string {
	let output = result.stdout.trim();
	if (result.stderr.trim()) output += `${output ? "\n" : ""}${result.stderr.trim()}`;
	if (!output) output = "browser-io failed with no output";
	if (result.killed) output += "\n[browser-io killed]";
	return output;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "browser",
		label: "Browser",
		description:
			"Navigate a persistent Firefox/Chromium session and optionally evaluate one JavaScript expression (use an async IIFE for multiple statements). Returns before/after HTML and screenshot paths plus eval results or capture/eval errors; process and response failures throw. Inspect HTML first and read only the screenshot needed for visual evidence. Output is truncated to " +
			`${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}.`,
		parameters: BROWSER_PARAMS,
		async execute(_toolCallId, params, signal) {
			const commandResult = await runBrowserIo(params, signal);
			if (commandResult.code !== 0 || commandResult.killed) {
				throw new Error(formatFailure(commandResult));
			}

			let result: BrowserResult;
			try {
				result = parseBrowserResult(commandResult.stdout);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				throw new Error(`${message}\n\n${formatFailure(commandResult)}`);
			}

			const output = truncateText(formatBrowserResult(result));
			return {
				content: [{ type: "text", text: output.text }],
				details: { ...result, truncated: output.truncated },
			};
		},
	});
}
