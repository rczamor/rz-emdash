/**
 * OpenRouter Plugin for EmDash CMS
 *
 * Single API key → access to any LLM (Anthropic, OpenAI, Google,
 * Mistral, Llama, etc.) via OpenRouter's OpenAI-compatible REST API.
 *
 * Three layers:
 *
 *   1. A pure client at `@emdash-cms/plugin-openrouter/client` —
 *      `chatCompletion`, `embeddings`, `listModels`. Importable from
 *      any plugin or user code; pass an apiKey + your own fetch.
 *
 *   2. Plugin admin routes:
 *
 *        POST /_emdash/api/plugins/openrouter/chat
 *        POST /_emdash/api/plugins/openrouter/complete
 *        POST /_emdash/api/plugins/openrouter/embeddings
 *        GET  /_emdash/api/plugins/openrouter/models
 *
 *      The plugin reads its API key from KV settings (configurable
 *      from the admin UI) or falls back to the OPENROUTER_API_KEY
 *      env var.
 *
 *   3. Automation action types — registered in the
 *      `@emdash-cms/plugin-automations` registry on module load:
 *
 *        - llm:chat         { model, messages, kvKey?: stash response }
 *        - llm:summarize    { model, input, prompt? }
 *        - llm:embed        { model, input, kvKey }
 *
 *      Routines can use these directly. e.g. on every published post,
 *      generate a summary and stash it in KV.
 *
 * Usage:
 *
 *   openrouterPlugin({
 *     apiKey: process.env.OPENROUTER_API_KEY,
 *     defaultModel: "anthropic/claude-haiku-4-5",
 *   })
 */

import type { PluginDescriptor } from "emdash";

export type {
	ChatCompletionInput,
	ChatCompletionResponse,
	ChatMessage,
	EmbeddingsInput,
	EmbeddingsResponse,
	OpenRouterConfig,
} from "./client.js";

export interface OpenRouterPluginOptions {
	/** API key. Falls back to OPENROUTER_API_KEY env var at runtime if omitted. */
	apiKey?: string;
	/** Default chat model (e.g. "anthropic/claude-haiku-4-5"). */
	defaultModel?: string;
	/** Default embeddings model (e.g. "openai/text-embedding-3-small"). */
	defaultEmbeddingsModel?: string;
	/** Site URL sent in the HTTP-Referer header — OpenRouter uses this for analytics. */
	siteUrl?: string;
	/** Site name sent in the X-Title header. */
	siteName?: string;
}

export function openrouterPlugin(_options: OpenRouterPluginOptions = {}): PluginDescriptor {
	return {
		id: "openrouter",
		version: "0.0.1",
		format: "standard",
		entrypoint: "@emdash-cms/plugin-openrouter/sandbox",
		options: {},
		capabilities: ["network:fetch"],
		allowedHosts: ["openrouter.ai"],
		storage: {
			usage: { indexes: ["createdAt", "model"] },
		},
		adminPages: [{ path: "/openrouter", label: "OpenRouter", icon: "sparkle" }],
		adminWidgets: [{ id: "openrouter-usage", title: "LLM usage (24h)", size: "half" }],
	};
}
