import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	AuthStorage,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

const OPENAI_CODEX_PROVIDER = "openai-codex";
const CODEX_SEARCH_URL = "https://chatgpt.com/backend-api/codex/alpha/search";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const DEFAULT_MODEL = "gpt-5.2";
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

const authStorage = AuthStorage.create();

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
	const credential = authStorage.getAll()[OPENAI_CODEX_PROVIDER] as OAuthCredential | undefined;
	if (credential?.type === "oauth" && typeof credential.accountId === "string" && credential.accountId.length > 0) {
		return credential.accountId;
	}
	return accountIdFromJwt(token);
}

async function getCodexAuth(): Promise<CodexAuth> {
	authStorage.reload();
	const token = await authStorage.getApiKey(OPENAI_CODEX_PROVIDER, { includeFallback: false });
	const errors = authStorage.drainErrors();
	if (!token) {
		const suffix = errors.length > 0 ? ` Last auth error: ${errors.at(-1)?.message}` : "";
		throw new Error(`No OpenAI Codex OAuth token found. Run /login and select ChatGPT Plus/Pro (Codex Subscription).${suffix}`);
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

async function postCodexSearch(request: SearchRequest, signal?: AbortSignal): Promise<string> {
	const auth = await getCodexAuth();
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

async function runCodexWeb(commands: SearchCommands, model: string, signal?: AbortSignal): Promise<CodexWebResult> {
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
	const output = await postCodexSearch(request, signal);
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
			"Search the web using the OpenAI Codex web backend and the existing openai-codex OAuth token. " +
			`Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}.`,
		promptSnippet: "Search the live web through the OpenAI Codex web backend; no Ollama dependency",
		promptGuidelines: [
			"Use web_search when the user asks to search, browse, verify current information, or find recent/source-backed facts.",
			"web_search returns source-backed web output from the Codex web backend; cite linked sources from the tool output in final answers when using it.",
		],
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
			"Fetch and extract text content from a web page using the OpenAI Codex web backend and the existing openai-codex OAuth token. " +
			`Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}.`,
		promptSnippet: "Fetch and extract a web page through the OpenAI Codex web backend; no Ollama dependency",
		promptGuidelines: [
			"Use web_fetch when the user provides a specific URL or asks to inspect the contents of a web page without needing browser screenshots or JavaScript execution.",
			"Use browser instead of web_fetch for pages that require visual inspection, screenshots, login state, or JavaScript evaluation.",
			"web_fetch returns source-backed page content from the Codex web backend; cite the fetched URL in final answers when using it.",
		],
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
				signal,
			);
			return {
				content: [{ type: "text", text: result.output }],
				details: result,
			};
		},
	});
}
