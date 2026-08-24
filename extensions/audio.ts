import type { ExtensionAPI, ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	readStoredCredential,
	truncateHead,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Type, type Static } from "typebox";

const OPENAI_CODEX_PROVIDER = "openai-codex";
const CODEX_TRANSCRIBE_URL = "https://chatgpt.com/backend-api/transcribe";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const SUPPORTED_EXTENSIONS = new Set([".mp3", ".mp4", ".mpeg", ".mpga", ".m4a", ".wav", ".webm"]);
const MIME_TYPES: Record<string, string> = {
	".mp3": "audio/mpeg",
	".mp4": "audio/mp4",
	".mpeg": "audio/mpeg",
	".mpga": "audio/mpeg",
	".m4a": "audio/mp4",
	".wav": "audio/wav",
	".webm": "audio/webm",
};

const TRANSCRIBE_AUDIO_PARAMS = Type.Object({
	path: Type.String({ description: "Audio file to transcribe, relative to the current working directory or absolute." }),
	language: Type.Optional(Type.String({ description: "Optional ISO-639-1 language code such as 'en' or 'et'. Automatic detection is used when omitted." })),
	output_path: Type.Optional(Type.String({ description: "Optional path for the complete plain-text transcript. Parent directories are created as needed." })),
});

type TranscribeAudioParams = Static<typeof TRANSCRIBE_AUDIO_PARAMS>;

interface OAuthCredential {
	type: "oauth";
	access?: string;
	accountId?: string;
}

interface CodexAuth {
	token: string;
	accountId: string;
}

interface TranscriptionResponse {
	text?: string;
	asset_pointer?: string;
	asset_ttl?: string;
	asset_format?: string;
}

function decodeBase64Url(value: string): string {
	const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
	return Buffer.from(padded, "base64").toString("utf8");
}

function accountIdFromJwt(token: string): string | undefined {
	try {
		const parts = token.split(".");
		if (parts.length !== 3 || !parts[1]) return undefined;
		const parsed = JSON.parse(decodeBase64Url(parts[1])) as unknown;
		if (typeof parsed !== "object" || parsed === null) return undefined;
		const auth = (parsed as Record<string, unknown>)[JWT_CLAIM_PATH];
		if (typeof auth !== "object" || auth === null) return undefined;
		const accountId = (auth as Record<string, unknown>).chatgpt_account_id;
		return typeof accountId === "string" && accountId.length > 0 ? accountId : undefined;
	} catch {
		return undefined;
	}
}

function currentAccountId(token: string): string | undefined {
	const credential = readStoredCredential(OPENAI_CODEX_PROVIDER) as OAuthCredential | undefined;
	if (credential?.type === "oauth" && typeof credential.accountId === "string" && credential.accountId.length > 0) {
		return credential.accountId;
	}
	return accountIdFromJwt(token);
}

async function getCodexAuth(modelRegistry: ModelRegistry): Promise<CodexAuth> {
	const token = await modelRegistry.getApiKeyForProvider(OPENAI_CODEX_PROVIDER);
	if (!token) {
		throw new Error("No OpenAI Codex OAuth token found. Run /login and select ChatGPT Plus/Pro (Codex Subscription).");
	}
	const accountId = currentAccountId(token);
	if (!accountId) {
		throw new Error("OpenAI Codex OAuth token did not include a ChatGPT account id. Run /login for openai-codex again.");
	}
	return { token, accountId };
}

function resolveToolPath(cwd: string, value: string): string {
	const normalized = value.trim().replace(/^@(?=[./~])/, "");
	if (!normalized) throw new Error("path must not be empty");
	if (normalized === "~") return process.env.HOME ?? normalized;
	if (normalized.startsWith("~/")) return path.join(process.env.HOME ?? "~", normalized.slice(2));
	return path.resolve(cwd, normalized);
}

function abbreviatedErrorBody(body: string): string {
	const trimmed = body.trim();
	return Buffer.byteLength(trimmed, "utf8") <= 2000 ? trimmed : `${Buffer.from(trimmed).subarray(0, 2000).toString("utf8")}…`;
}

async function transcribe(
	audioPath: string,
	language: string | undefined,
	modelRegistry: ModelRegistry,
	signal?: AbortSignal,
): Promise<TranscriptionResponse & { text: string }> {
	const extension = path.extname(audioPath).toLowerCase();
	if (!SUPPORTED_EXTENSIONS.has(extension)) {
		throw new Error(`Unsupported audio type '${extension || "(none)"}'. Supported types: ${[...SUPPORTED_EXTENSIONS].join(", ")}`);
	}
	const fileStat = await stat(audioPath);
	if (!fileStat.isFile()) throw new Error(`Audio path is not a regular file: ${audioPath}`);
	if (fileStat.size > MAX_AUDIO_BYTES) {
		throw new Error(`Audio file is ${formatSize(fileStat.size)}; the upload limit is ${formatSize(MAX_AUDIO_BYTES)}. Split or compress it first.`);
	}

	const auth = await getCodexAuth(modelRegistry);
	const bytes = await readFile(audioPath);
	const form = new FormData();
	form.append("file", new Blob([new Uint8Array(bytes)], { type: MIME_TYPES[extension] }), path.basename(audioPath));
	if (language) form.append("language", language);

	const response = await fetch(CODEX_TRANSCRIBE_URL, {
		method: "POST",
		headers: {
			"Authorization": `Bearer ${auth.token}`,
			"ChatGPT-Account-ID": auth.accountId,
			"User-Agent": "pi-ant/codex-audio",
			"originator": "pi-ant",
		},
		body: form,
		signal,
	});
	const responseText = await response.text();
	if (!response.ok) {
		const message = abbreviatedErrorBody(responseText) || response.statusText;
		if (response.status === 401 || response.status === 403) {
			throw new Error(`Codex transcription authentication failed (${response.status}). Run /login for openai-codex again. ${message}`.trim());
		}
		throw new Error(`Codex transcription failed (${response.status}): ${message}`);
	}

	let parsed: TranscriptionResponse;
	try {
		parsed = JSON.parse(responseText) as TranscriptionResponse;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Codex transcription returned invalid JSON: ${message}`);
	}
	if (typeof parsed.text !== "string") throw new Error("Codex transcription response did not contain text");
	return { ...parsed, text: parsed.text.trim() };
}

async function writeTranscript(outputPath: string, text: string): Promise<void> {
	await withFileMutationQueue(outputPath, async () => {
		await mkdir(path.dirname(outputPath), { recursive: true });
		await writeFile(outputPath, `${text}\n`, "utf8");
	});
}

async function truncateTranscript(text: string, savedPath: string | undefined): Promise<{ output: string; truncated: boolean; savedPath?: string }> {
	const truncation = truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
	if (!truncation.truncated) return { output: truncation.content, truncated: false, savedPath };

	let fullPath = savedPath;
	if (!fullPath) {
		const directory = await mkdtemp(path.join(tmpdir(), "pi-transcription-"));
		fullPath = path.join(directory, "transcript.txt");
		await writeFile(fullPath, `${text}\n`, "utf8");
	}
	const suffix = `\n\n[Transcript truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full transcript: ${fullPath}]`;
	return { output: truncation.content + suffix, truncated: true, savedPath: fullPath };
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "transcribe_audio",
		label: "Transcribe Audio",
		description:
			"Transcribe a local audio file through the OpenAI Codex/ChatGPT speech backend using the stored OpenAI Codex OAuth login. " +
			`Supports mp3, mp4, mpeg, mpga, m4a, wav, and webm files up to ${formatSize(MAX_AUDIO_BYTES)}. ` +
			`Tool output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}; output_path saves the complete transcript.`,
		parameters: TRANSCRIBE_AUDIO_PARAMS,
		async execute(_toolCallId, params: TranscribeAudioParams, signal, onUpdate, ctx) {
			const audioPath = resolveToolPath(ctx.cwd, params.path);
			const language = params.language?.trim();
			if (params.language !== undefined && !language) throw new Error("language must not be empty when provided");
			const outputPath = params.output_path ? resolveToolPath(ctx.cwd, params.output_path) : undefined;
			onUpdate?.({
				content: [{ type: "text", text: `Transcribing ${audioPath}…` }],
				details: {},
			});

			const result = await transcribe(audioPath, language, ctx.modelRegistry, signal);
			if (outputPath) await writeTranscript(outputPath, result.text);
			const displayed = await truncateTranscript(result.text, outputPath);
			const savedNotice = outputPath && !displayed.truncated ? `\n\n[Full transcript saved to ${outputPath}]` : "";
			return {
				content: [{ type: "text", text: displayed.output + savedNotice }],
				details: {
					url: CODEX_TRANSCRIBE_URL,
					audioPath,
					language,
					outputPath: displayed.savedPath,
					truncated: displayed.truncated,
					assetPointer: result.asset_pointer,
					assetTtl: result.asset_ttl,
					assetFormat: result.asset_format,
				},
			};
		},
	});
}
