import type { ExtensionAPI, ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	readStoredCredential,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

const OPENAI_CODEX_PROVIDER = "openai-codex";
const CODEX_SEARCH_URL = "https://chatgpt.com/backend-api/codex/alpha/search";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const DEFAULT_MODEL = "gpt-5.6-sol";
const DEFAULT_MAX_OUTPUT_TOKENS = 8000;

const WEB_SEARCH_PARAMS = Type.Object({
	query: Type.String({ description: "The web search query to execute." }),
	max_results: Type.Optional(Type.Integer({
		description: "Maximum number of search results to prefer. The Codex web backend may return a different number. Defaults to 5.",
		minimum: 1,
		maximum: 10,
	})),
});

const WEB_FETCH_PARAMS = Type.Object({
	url: Type.String({ description: "URL to fetch and extract text content from." }),
});

type WebSearchParams = Static<typeof WEB_SEARCH_PARAMS>;
type WebFetchParams = Static<typeof WEB_FETCH_PARAMS>;
type SearchResponseLength = "short" | "medium" | "long";

interface OAuthCredential {
	type: "oauth";
	access?: string;
	accountId?: string;
	expires?: number;
}

interface SearchQuery {
	q: string;
	recency?: number;
	domains?: string[];
}

interface SearchCommands {
	search_query?: SearchQuery[];
	open?: Array<{ ref_id: string; lineno?: number }>;
	response_length?: SearchResponseLength;
}

interface SearchSettings {
	allowed_callers: ["direct"];
	external_web_access: true;
}

interface SearchRequest {
	id: string;
	model: string;
	commands: SearchCommands;
	settings: SearchSettings;
	max_output_tokens: number;
}

interface SearchResponse {
	encrypted_output?: string;
	output?: string;
}

interface CodexAuth {
	token: string;
	accountId: string;
}

interface CodexWebResult {
	url: string;
	model: string;
	commands: SearchCommands;
	output: string;
	truncated: boolean;
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

function chooseResponseLength(maxResults: number | undefined): SearchResponseLength {
	const requested = maxResults ?? 5;
	if (requested <= 3) return "short";
	if (requested <= 6) return "medium";
	return "long";
}

function requestId(): string {
	if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
	return `pi-ant-web-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function modelForRequest(ctxModel: { provider: string; id: string } | undefined): string {
	if (ctxModel?.provider === OPENAI_CODEX_PROVIDER) return ctxModel.id;
	return DEFAULT_MODEL;
}

async function postCodexSearch(
	request: SearchRequest,
	modelRegistry: ModelRegistry,
	signal?: AbortSignal,
): Promise<string> {
	const auth = await getCodexAuth(modelRegistry);
	const response = await fetch(CODEX_SEARCH_URL, {
		method: "POST",
		headers: {
			"Authorization": `Bearer ${auth.token}`,
			"ChatGPT-Account-ID": auth.accountId,
			"Content-Type": "application/json",
			"User-Agent": "pi-ant/codex-web",
			"originator": "pi-ant",
		},
		body: JSON.stringify(request),
		signal,
	});

	const responseText = await response.text();
	if (!response.ok) {
		const message = responseText.trim() || response.statusText;
		if (response.status === 401 || response.status === 403) {
			throw new Error(`Codex web API authentication failed (${response.status}). Run /login for openai-codex again. ${message}`.trim());
		}
		throw new Error(`Codex web API request failed (${response.status}): ${message}`);
	}

	let parsed: SearchResponse;
	try {
		parsed = JSON.parse(responseText) as SearchResponse;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Codex web API returned invalid JSON: ${message}\n\n${responseText}`);
	}

	if (typeof parsed.output !== "string") {
		throw new Error(`Codex web API response missing output: ${responseText}`);
	}
	return parsed.output;
}

function truncateOutput(output: string): { text: string; truncated: boolean } {
	const truncation = truncateHead(output, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});
	let text = truncation.content;
	if (truncation.truncated) {
		text += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`;
		text += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).]`;
	}
	return { text, truncated: truncation.truncated };
}

async function runCodexWeb(
	commands: SearchCommands,
	model: string,
	modelRegistry: ModelRegistry,
	signal?: AbortSignal,
): Promise<CodexWebResult> {
	const request: SearchRequest = {
		id: requestId(),
		model,
		commands,
		settings: {
			allowed_callers: ["direct"],
			external_web_access: true,
		},
		max_output_tokens: DEFAULT_MAX_OUTPUT_TOKENS,
	};
	const output = await postCodexSearch(request, modelRegistry, signal);
	const truncated = truncateOutput(output);
	return {
		url: CODEX_SEARCH_URL,
		model,
		commands,
		output: truncated.text,
		truncated: truncated.truncated,
	};
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the live web through the OpenAI Codex backend. Returns source-backed text whose linked sources should be cited; authentication and request failures throw. " +
			`Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}.`,
		parameters: WEB_SEARCH_PARAMS,
		async execute(_toolCallId, params: WebSearchParams, signal, _onUpdate, ctx) {
			const query = params.query.trim();
			if (!query) throw new Error("query must not be empty");
			const result = await runCodexWeb(
				{
					search_query: [{ q: query }],
					response_length: chooseResponseLength(params.max_results),
				},
				modelForRequest(ctx.model),
				ctx.modelRegistry,
				signal,
			);
			return {
				content: [{ type: "text", text: result.output }],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: "web_fetch",
		label: "Web Fetch",
		description:
			"Fetch and extract source-backed text from one URL through the OpenAI Codex backend; use browser instead for visual inspection, login state, or JavaScript. Cite the fetched URL; invalid URLs, authentication, and request failures throw. " +
			`Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}.`,
		parameters: WEB_FETCH_PARAMS,
		async execute(_toolCallId, params: WebFetchParams, signal, _onUpdate, ctx) {
			const url = params.url.trim();
			if (!url) throw new Error("url must not be empty");
			try {
				const parsed = new URL(url);
				if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
					throw new Error("URL protocol must be http or https");
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				throw new Error(`Invalid URL: ${message}`);
			}
			const result = await runCodexWeb(
				{
					open: [{ ref_id: url }],
					response_length: "long",
				},
				modelForRequest(ctx.model),
				ctx.modelRegistry,
				signal,
			);
			return {
				content: [{ type: "text", text: result.output }],
				details: result,
			};
		},
	});
}
