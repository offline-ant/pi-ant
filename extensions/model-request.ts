import type { AssistantMessage, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface ModelRequest {
	systemPrompt: string;
	prompt: string;
	maxTokens: number;
	/** Routing key, kept distinct from the agent's own session id. */
	sessionId: string;
	thinkingLevel: ReturnType<ExtensionAPI["getThinkingLevel"]>;
}

/**
 * One single-shot model request on the session's current model, outside the agent loop.
 *
 * Dispatch goes through the session's provider rather than `completeSimple` from
 * `@earendil-works/pi-ai/compat`, which resolves only pi-ai's global api registry and
 * therefore fails for providers an extension registered, such as pi-claude-agent.
 * These requests never write to the agent's prompt cache or live provider session.
 */
export async function completeOnce(ctx: ExtensionContext, request: ModelRequest): Promise<AssistantMessage> {
	const model = ctx.model;
	if (!model) throw new Error("No model selected");
	const provider = ctx.modelRegistry.getProvider(model.provider);
	if (!provider) throw new Error(`Unknown provider: ${model.provider}`);
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (auth.ok === false) throw new Error(auth.error);

	const options: SimpleStreamOptions = {
		apiKey: auth.apiKey,
		headers: auth.headers,
		env: auth.env,
		maxTokens: model.maxTokens > 0 ? Math.min(request.maxTokens, model.maxTokens) : request.maxTokens,
		cacheRetention: "none",
		sessionId: request.sessionId,
	};
	if (model.reasoning && request.thinkingLevel !== "off") options.reasoning = request.thinkingLevel;

	return provider
		.streamSimple(
			auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model,
			{
				systemPrompt: request.systemPrompt,
				messages: [{ role: "user", content: [{ type: "text", text: request.prompt }], timestamp: Date.now() }],
			},
			options,
		)
		.result();
}
