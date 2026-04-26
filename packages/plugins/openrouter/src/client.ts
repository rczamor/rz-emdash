/**
 * OpenRouter client utilities — pure HTTP wrappers around the
 * OpenRouter REST API. Importable from any plugin or user code.
 *
 * The API surface is OpenAI-compatible: `/chat/completions` accepts
 * an `messages` array, returns `{ choices: [{ message }], usage }`.
 *
 * https://openrouter.ai/docs/api-reference
 */

export interface ChatMessage {
	role: "system" | "user" | "assistant" | "tool";
	content: string;
	name?: string;
}

export interface ChatCompletionInput {
	model: string;
	messages: ChatMessage[];
	temperature?: number;
	max_tokens?: number;
	top_p?: number;
	response_format?: { type: "json_object" | "text" };
	stop?: string[];
	stream?: false;
	/** Pass-through pricing/routing constraints — see OpenRouter docs */
	provider?: Record<string, unknown>;
}

export interface ChatCompletionResponse {
	id: string;
	model: string;
	created: number;
	choices: Array<{
		index: number;
		message: ChatMessage;
		finish_reason: string;
	}>;
	usage?: {
		prompt_tokens: number;
		completion_tokens: number;
		total_tokens: number;
	};
}

export interface EmbeddingsInput {
	model: string;
	input: string | string[];
}

export interface EmbeddingsResponse {
	data: Array<{ embedding: number[]; index: number }>;
	model: string;
	usage?: { prompt_tokens: number; total_tokens: number };
}

export interface OpenRouterConfig {
	apiKey: string;
	/** OpenRouter recommends sending these for analytics + rate-limit fairness */
	siteUrl?: string;
	siteName?: string;
	/** Override base URL for testing or proxying */
	baseUrl?: string;
	/** Use the supplied fetch function (e.g. `ctx.http.fetch`) when running sandboxed */
	fetchImpl?: typeof fetch;
}

const DEFAULT_BASE = "https://openrouter.ai/api/v1";

function authHeaders(config: OpenRouterConfig): Record<string, string> {
	const headers: Record<string, string> = {
		Authorization: `Bearer ${config.apiKey}`,
		"Content-Type": "application/json",
	};
	if (config.siteUrl) headers["HTTP-Referer"] = config.siteUrl;
	if (config.siteName) headers["X-Title"] = config.siteName;
	return headers;
}

export async function chatCompletion(
	input: ChatCompletionInput,
	config: OpenRouterConfig,
): Promise<ChatCompletionResponse> {
	if (!config.apiKey) throw new Error("OpenRouter: apiKey missing");
	const fetchImpl = config.fetchImpl ?? globalThis.fetch;
	const baseUrl = (config.baseUrl ?? DEFAULT_BASE).replace(/\/$/, "");
	const res = await fetchImpl(`${baseUrl}/chat/completions`, {
		method: "POST",
		headers: authHeaders(config),
		body: JSON.stringify(input),
	});
	if (!res.ok) {
		const text = await res.text().catch(() => "<unreadable>");
		throw new Error(`OpenRouter chat ${res.status}: ${text.slice(0, 300)}`);
	}
	return (await res.json()) as ChatCompletionResponse;
}

export async function embeddings(
	input: EmbeddingsInput,
	config: OpenRouterConfig,
): Promise<EmbeddingsResponse> {
	if (!config.apiKey) throw new Error("OpenRouter: apiKey missing");
	const fetchImpl = config.fetchImpl ?? globalThis.fetch;
	const baseUrl = (config.baseUrl ?? DEFAULT_BASE).replace(/\/$/, "");
	const res = await fetchImpl(`${baseUrl}/embeddings`, {
		method: "POST",
		headers: authHeaders(config),
		body: JSON.stringify(input),
	});
	if (!res.ok) {
		const text = await res.text().catch(() => "<unreadable>");
		throw new Error(`OpenRouter embeddings ${res.status}: ${text.slice(0, 300)}`);
	}
	return (await res.json()) as EmbeddingsResponse;
}

/**
 * Helper: extract the assistant message text from a chat completion.
 * Returns "" if no choice/message is present.
 */
export function extractText(response: ChatCompletionResponse): string {
	return response.choices[0]?.message.content ?? "";
}

/**
 * Helper: list available models. Useful from admin pages to populate a
 * model picker.
 */
export async function listModels(
	config: OpenRouterConfig,
): Promise<Array<{ id: string; name?: string; pricing?: Record<string, unknown> }>> {
	if (!config.apiKey) throw new Error("OpenRouter: apiKey missing");
	const fetchImpl = config.fetchImpl ?? globalThis.fetch;
	const baseUrl = (config.baseUrl ?? DEFAULT_BASE).replace(/\/$/, "");
	const res = await fetchImpl(`${baseUrl}/models`, {
		method: "GET",
		headers: authHeaders(config),
	});
	if (!res.ok) {
		throw new Error(`OpenRouter models ${res.status}`);
	}
	const json = (await res.json()) as { data?: Array<Record<string, unknown>> };
	return (json.data ?? []) as Array<{ id: string; name?: string; pricing?: Record<string, unknown> }>;
}
