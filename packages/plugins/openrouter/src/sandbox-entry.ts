/**
 * OpenRouter — runtime entrypoint.
 *
 * Routes:
 *   POST  chat                       admin   body: { model?, messages, … }
 *   POST  complete                   admin   body: { model?, prompt }   (sugar over chat)
 *   POST  embeddings                 admin   body: { model?, input }
 *   GET   models                     admin
 *   GET   settings                   admin   returns model + key-set status
 *   POST  settings.save              admin   body: { defaultModel?, defaultEmbeddingsModel? }
 *   POST  settings.setKey            admin   body: { apiKey }
 *   POST  admin                      Block Kit
 *
 * Hooks: plugin:install registers automation action types.
 */

import { definePlugin } from "emdash";
import type { PluginContext } from "emdash";
import { registerAction } from "@emdash-cms/plugin-automations/registry";
import { resolveTokens } from "@emdash-cms/plugin-tokens/resolver";

import {
	chatCompletion,
	embeddings,
	extractText,
	listModels,
	type ChatCompletionInput,
	type ChatMessage,
	type OpenRouterConfig,
} from "./client.js";

const KEY_KV = "settings:apiKey";
const DEFAULT_MODEL_KV = "settings:defaultModel";
const DEFAULT_EMBED_MODEL_KV = "settings:defaultEmbeddingsModel";

interface RouteCtx {
	input: unknown;
	request: Request;
}

const NOW = () => new Date().toISOString();

async function getConfig(ctx: PluginContext): Promise<OpenRouterConfig | null> {
	const stored = (await ctx.kv.get<string>(KEY_KV)) ?? process.env.OPENROUTER_API_KEY;
	if (!stored) return null;
	const siteUrl =
		(ctx.site as { url?: string } | undefined)?.url ?? process.env.SITE_URL ?? undefined;
	const siteName = ctx.site?.name ?? "EmDash";
	return {
		apiKey: stored,
		siteUrl,
		siteName,
		fetchImpl: ctx.http?.fetch.bind(ctx.http),
	};
}

async function getDefaultModel(ctx: PluginContext): Promise<string> {
	return (
		(await ctx.kv.get<string>(DEFAULT_MODEL_KV)) ?? "anthropic/claude-haiku-4-5"
	);
}

async function getDefaultEmbeddingsModel(ctx: PluginContext): Promise<string> {
	return (
		(await ctx.kv.get<string>(DEFAULT_EMBED_MODEL_KV)) ?? "openai/text-embedding-3-small"
	);
}

async function recordUsage(
	ctx: PluginContext,
	model: string,
	usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number },
): Promise<void> {
	const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	await ctx.storage.usage.put(id, {
		model,
		promptTokens: usage.prompt_tokens ?? 0,
		completionTokens: usage.completion_tokens ?? 0,
		totalTokens: usage.total_tokens ?? 0,
		createdAt: NOW(),
	});
}

// ── Automation action types ─────────────────────────────────────────────────
//
// Registered on module load (this file is imported when the plugin
// loads). The PluginContext at registration time is unknown — runners
// receive a real ctx at execution time.

interface LlmChatAction {
	type: "llm:chat";
	model?: string;
	system?: string;
	prompt: string;
	temperature?: number;
	maxTokens?: number;
	/** If set, the assistant message text is stored at ctx.kv[kvKey]. */
	kvKey?: string;
}

interface LlmSummarizeAction {
	type: "llm:summarize";
	model?: string;
	input: string;
	prompt?: string;
	maxTokens?: number;
	kvKey?: string;
}

interface LlmEmbedAction {
	type: "llm:embed";
	model?: string;
	input: string;
	kvKey: string;
}

registerAction<LlmChatAction>("llm:chat", async (action, tokenCtx, ctx) => {
	const config = await getConfig(ctx);
	if (!config) throw new Error("OpenRouter: API key not configured");
	const model = action.model ?? (await getDefaultModel(ctx));
	const messages: ChatMessage[] = [];
	if (action.system) messages.push({ role: "system", content: await resolveTokens(action.system, tokenCtx) });
	messages.push({ role: "user", content: await resolveTokens(action.prompt, tokenCtx) });
	const response = await chatCompletion(
		{
			model,
			messages,
			temperature: action.temperature,
			max_tokens: action.maxTokens,
		},
		config,
	);
	if (response.usage) await recordUsage(ctx, model, response.usage);
	if (action.kvKey) {
		await ctx.kv.set(await resolveTokens(action.kvKey, tokenCtx), extractText(response));
	}
});

registerAction<LlmSummarizeAction>("llm:summarize", async (action, tokenCtx, ctx) => {
	const config = await getConfig(ctx);
	if (!config) throw new Error("OpenRouter: API key not configured");
	const model = action.model ?? (await getDefaultModel(ctx));
	const userPrompt =
		action.prompt ??
		"Summarize the following content in 2-3 sentences. Be neutral and factual.";
	const inputText = await resolveTokens(action.input, tokenCtx);
	const response = await chatCompletion(
		{
			model,
			messages: [
				{ role: "system", content: userPrompt },
				{ role: "user", content: inputText },
			],
			max_tokens: action.maxTokens ?? 300,
		},
		config,
	);
	if (response.usage) await recordUsage(ctx, model, response.usage);
	if (action.kvKey) {
		await ctx.kv.set(await resolveTokens(action.kvKey, tokenCtx), extractText(response));
	}
});

registerAction<LlmEmbedAction>("llm:embed", async (action, tokenCtx, ctx) => {
	const config = await getConfig(ctx);
	if (!config) throw new Error("OpenRouter: API key not configured");
	const model = action.model ?? (await getDefaultEmbeddingsModel(ctx));
	const inputText = await resolveTokens(action.input, tokenCtx);
	const response = await embeddings({ model, input: inputText }, config);
	if (response.usage) await recordUsage(ctx, model, { total_tokens: response.usage.total_tokens });
	const vector = response.data[0]?.embedding ?? [];
	await ctx.kv.set(await resolveTokens(action.kvKey, tokenCtx), vector);
});

// ── Block Kit admin ─────────────────────────────────────────────────────────

async function buildAdminPage(ctx: PluginContext) {
	const apiKey = await ctx.kv.get<string>(KEY_KV);
	const defaultModel = await getDefaultModel(ctx);
	const defaultEmbed = await getDefaultEmbeddingsModel(ctx);

	const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
	const recent = await ctx.storage.usage.query({
		orderBy: { createdAt: "desc" },
		limit: 1000,
	});
	const last24 = recent.items
		.map((i) => i.data as { totalTokens: number; createdAt: string; model: string })
		.filter((u) => u.createdAt >= oneDayAgo);
	const totalTokens = last24.reduce((sum, u) => sum + (u.totalTokens ?? 0), 0);
	const callCount = last24.length;

	return {
		blocks: [
			{ type: "header", text: "OpenRouter" },
			{
				type: "stats",
				stats: [
					{ label: "API key", value: apiKey ? "Set" : "Not set" },
					{ label: "Calls 24h", value: String(callCount) },
					{ label: "Tokens 24h", value: String(totalTokens) },
				],
			},
			!apiKey
				? {
						type: "banner",
						variant: "alert",
						title: "API key not set",
						description:
							"Set OPENROUTER_API_KEY env var or POST to /_emdash/api/plugins/openrouter/settings.setKey",
					}
				: { type: "divider" },
			{ type: "header", text: "Defaults" },
			{
				type: "form",
				block_id: "openrouter-defaults",
				fields: [
					{
						type: "text_input",
						action_id: "defaultModel",
						label: "Default chat model",
						initial_value: defaultModel,
					},
					{
						type: "text_input",
						action_id: "defaultEmbeddingsModel",
						label: "Default embeddings model",
						initial_value: defaultEmbed,
					},
				],
				submit: { label: "Save", action_id: "save_defaults" },
			},
			{ type: "header", text: "Recent calls" },
			{
				type: "table",
				blockId: "openrouter-usage",
				columns: [
					{ key: "model", label: "Model", format: "text" },
					{ key: "tokens", label: "Tokens", format: "text" },
					{ key: "createdAt", label: "When", format: "relative_time" },
				],
				rows: last24.slice(0, 20).map((u) => ({
					model: u.model,
					tokens: String(u.totalTokens),
					createdAt: u.createdAt,
				})),
			},
		],
	};
}

async function buildUsageWidget(ctx: PluginContext) {
	const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
	const recent = await ctx.storage.usage.query({
		orderBy: { createdAt: "desc" },
		limit: 500,
	});
	const last24 = recent.items
		.map((i) => i.data as { totalTokens: number; createdAt: string; model: string })
		.filter((u) => u.createdAt >= oneDayAgo);
	const totalTokens = last24.reduce((sum, u) => sum + (u.totalTokens ?? 0), 0);
	const callCount = last24.length;
	return {
		blocks: [
			{ type: "header", text: "LLM usage — 24h" },
			{
				type: "stats",
				stats: [
					{ label: "Calls", value: String(callCount) },
					{ label: "Tokens", value: String(totalTokens) },
				],
			},
		],
	};
}

// ── Plugin definition ───────────────────────────────────────────────────────

export default definePlugin({
	hooks: {
		"plugin:install": {
			handler: async (_event, ctx: PluginContext) => {
				ctx.log.info("OpenRouter plugin installed (registered llm:chat / llm:summarize / llm:embed actions)");
			},
		},
	},

	routes: {
		chat: {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const body = routeCtx.input as Partial<ChatCompletionInput> | null;
				if (!body || !body.messages) return { ok: false, error: "messages required" };
				const config = await getConfig(ctx);
				if (!config) return { ok: false, error: "API key not configured" };
				const model = body.model ?? (await getDefaultModel(ctx));
				try {
					const response = await chatCompletion({ ...body, model, messages: body.messages }, config);
					if (response.usage) await recordUsage(ctx, model, response.usage);
					return { ok: true, response };
				} catch (err) {
					return { ok: false, error: err instanceof Error ? err.message : String(err) };
				}
			},
		},

		complete: {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const body = routeCtx.input as { model?: string; prompt?: string } | null;
				if (!body || !body.prompt) return { ok: false, error: "prompt required" };
				const config = await getConfig(ctx);
				if (!config) return { ok: false, error: "API key not configured" };
				const model = body.model ?? (await getDefaultModel(ctx));
				try {
					const response = await chatCompletion(
						{ model, messages: [{ role: "user", content: body.prompt }] },
						config,
					);
					if (response.usage) await recordUsage(ctx, model, response.usage);
					return { ok: true, text: extractText(response), response };
				} catch (err) {
					return { ok: false, error: err instanceof Error ? err.message : String(err) };
				}
			},
		},

		embeddings: {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const body = routeCtx.input as { model?: string; input?: string | string[] } | null;
				if (!body || !body.input) return { ok: false, error: "input required" };
				const config = await getConfig(ctx);
				if (!config) return { ok: false, error: "API key not configured" };
				const model = body.model ?? (await getDefaultEmbeddingsModel(ctx));
				try {
					const response = await embeddings({ model, input: body.input }, config);
					if (response.usage)
						await recordUsage(ctx, model, { total_tokens: response.usage.total_tokens });
					return { ok: true, response };
				} catch (err) {
					return { ok: false, error: err instanceof Error ? err.message : String(err) };
				}
			},
		},

		models: {
			handler: async (_routeCtx: RouteCtx, ctx: PluginContext) => {
				const config = await getConfig(ctx);
				if (!config) return { ok: false, error: "API key not configured" };
				try {
					const models = await listModels(config);
					return { ok: true, models };
				} catch (err) {
					return { ok: false, error: err instanceof Error ? err.message : String(err) };
				}
			},
		},

		settings: {
			handler: async (_routeCtx: RouteCtx, ctx: PluginContext) => {
				const apiKey = await ctx.kv.get<string>(KEY_KV);
				return {
					ok: true,
					hasApiKey: Boolean(apiKey || process.env.OPENROUTER_API_KEY),
					defaultModel: await getDefaultModel(ctx),
					defaultEmbeddingsModel: await getDefaultEmbeddingsModel(ctx),
				};
			},
		},

		"settings.save": {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const body = routeCtx.input as
					| { defaultModel?: string; defaultEmbeddingsModel?: string }
					| null;
				if (!body) return { ok: false, error: "Body required" };
				if (body.defaultModel) await ctx.kv.set(DEFAULT_MODEL_KV, body.defaultModel);
				if (body.defaultEmbeddingsModel)
					await ctx.kv.set(DEFAULT_EMBED_MODEL_KV, body.defaultEmbeddingsModel);
				return { ok: true };
			},
		},

		"settings.setKey": {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const body = routeCtx.input as { apiKey?: string } | null;
				if (!body?.apiKey) return { ok: false, error: "apiKey required" };
				await ctx.kv.set(KEY_KV, body.apiKey);
				return { ok: true };
			},
		},

		admin: {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const interaction = routeCtx.input as {
					type?: string;
					page?: string;
					widget?: string;
					action_id?: string;
					values?: Record<string, unknown>;
				};
				if (interaction.type === "page_load" && interaction.page === "/openrouter") {
					return await buildAdminPage(ctx);
				}
				if (interaction.type === "widget_load" && interaction.widget === "openrouter-usage") {
					return await buildUsageWidget(ctx);
				}
				if (interaction.type === "form_submit" && interaction.action_id === "save_defaults") {
					const v = interaction.values ?? {};
					if (v.defaultModel) await ctx.kv.set(DEFAULT_MODEL_KV, String(v.defaultModel));
					if (v.defaultEmbeddingsModel)
						await ctx.kv.set(DEFAULT_EMBED_MODEL_KV, String(v.defaultEmbeddingsModel));
					return {
						...(await buildAdminPage(ctx)),
						toast: { message: "Defaults saved", type: "success" },
					};
				}
				return { blocks: [] };
			},
		},
	},
});
