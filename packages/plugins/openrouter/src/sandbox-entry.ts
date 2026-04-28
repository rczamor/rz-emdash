/**
 * OpenRouter — runtime entrypoint.
 *
 * Routes:
 *   POST  chat               body: { model?, messages, … } + agent_id?, task_id?, useTools?
 *   POST  complete           sugar over chat: body: { model?, prompt, agent_id?, task_id? }
 *   POST  embeddings
 *   GET   models
 *   GET   settings
 *   POST  settings.save
 *   POST  settings.setKey
 *   POST  admin              Block Kit
 *
 * Hooks: plugin:install registers automation actions (llm:chat,
 * llm:summarize, llm:embed, llm:agent).
 *
 * Tasks/Agents/Tools integration:
 *
 *   - When `agent_id` is supplied, the route fetches the agent's
 *     compiled context from the Agents plugin and prepends it as a
 *     system message. Tools are filtered to the agent's allowlist
 *     via the Tools plugin.
 *   - When `task_id` is supplied, the route checks the Tasks-plugin
 *     quota first and rejects if exceeded; every model call records
 *     cost on the task; tool invocations attach to the task's
 *     activity log.
 *   - When `useTools` is true (or `agent_id` is set), the route runs
 *     the OpenAI tool-call loop until the model finishes or hits the
 *     iteration limit.
 */

import { registerAction } from "@emdash-cms/plugin-automations/registry";
import { resolveTokens } from "@emdash-cms/plugin-tokens/resolver";
import { definePlugin } from "emdash";
import type { PluginContext } from "emdash";

import { runChatLoop } from "./chat-loop.js";
import {
	chatCompletion,
	embeddings,
	extractText,
	listModels,
	type ChatCompletionInput,
	type ChatMessage,
	type OpenRouterConfig,
} from "./client.js";
import { checkQuota, compileAgentSystemPrompt, fetchAgentToolsForOpenAI } from "./task-context.js";

const TRAILING_SLASH_RE = /\/$/;

const KEY_KV = "settings:apiKey";
const DEFAULT_MODEL_KV = "settings:defaultModel";
const DEFAULT_EMBED_MODEL_KV = "settings:defaultEmbeddingsModel";

interface RouteCtx {
	input: unknown;
	request: Request;
}

const NOW = () => new Date().toISOString();

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

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
	return (await ctx.kv.get<string>(DEFAULT_MODEL_KV)) ?? "anthropic/claude-haiku-4-5";
}

async function getDefaultEmbeddingsModel(ctx: PluginContext): Promise<string> {
	return (await ctx.kv.get<string>(DEFAULT_EMBED_MODEL_KV)) ?? "openai/text-embedding-3-small";
}

async function recordUsage(
	ctx: PluginContext,
	model: string,
	usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number },
): Promise<void> {
	const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	await ctx.storage.usage!.put(id, {
		model,
		promptTokens: usage.prompt_tokens ?? 0,
		completionTokens: usage.completion_tokens ?? 0,
		totalTokens: usage.total_tokens ?? 0,
		createdAt: NOW(),
	});
}

// ── Agent-aware chat helper ─────────────────────────────────────────────────

interface AgentAwareChatInput {
	body: Partial<ChatCompletionInput> & {
		agent_id?: string;
		task_id?: string;
		useTools?: boolean;
	};
}

async function runAgentAwareChat(
	input: AgentAwareChatInput,
	ctx: PluginContext,
): Promise<{ ok: true; response: unknown } | { ok: false; error: string }> {
	const { body } = input;
	if (!body.messages) return { ok: false, error: "messages required" };

	const config = await getConfig(ctx);
	if (!config) return { ok: false, error: "API key not configured" };

	// Compile agent system prompt + tools
	let messages: ChatMessage[] = [...body.messages];
	let model = body.model;
	let tools = body.tools;

	if (body.agent_id) {
		const compiled = await compileAgentSystemPrompt(body.agent_id, 10, ctx);
		if (!compiled) {
			return { ok: false, error: "Agent not found or inactive" };
		}
		messages = [{ role: "system", content: compiled.systemPrompt }, ...messages];
		if (!model) model = compiled.agentModel;
		if (!tools && compiled.agentTools.length > 0) {
			tools = await fetchAgentToolsForOpenAI(body.agent_id, ctx);
		}
	}

	if (!model) model = await getDefaultModel(ctx);

	// Quota check
	if (body.task_id) {
		const actor = body.agent_id ? `agent:${body.agent_id}` : "system";
		const quota = await checkQuota(
			{ actor, taskId: body.task_id, estimatedTokensIn: 0, estimatedTokensOut: body.max_tokens },
			ctx,
		);
		if (!quota.ok) {
			return { ok: false, error: quota.reason ?? "Quota exceeded" };
		}
	}

	// If tools are present (or useTools requested), run the loop.
	if ((tools && tools.length > 0) || body.useTools) {
		// Scope the fallback fetch to the agent's allowlist when an
		// agent_id was supplied; the unscoped path returns every
		// registered tool, which would let the model attempt calls
		// the agent isn't permitted to make.
		if (!tools && body.useTools) {
			tools = await fetchAgentToolsForOpenAI(body.agent_id, ctx);
		}
		const result = await runChatLoop(
			{
				completionInput: { ...body, model, messages, tools },
				config,
				taskId: body.task_id,
				agentId: body.agent_id,
			},
			ctx,
		);
		await recordUsage(ctx, model, {
			prompt_tokens: result.totalCost.tokensIn,
			completion_tokens: result.totalCost.tokensOut,
			total_tokens: result.totalCost.tokensIn + result.totalCost.tokensOut,
		});
		return {
			ok: true,
			response: {
				message: result.final,
				history: result.history,
				cost: result.totalCost,
				invocations: result.invocations,
				terminated: result.terminated,
			},
		};
	}

	// Plain single-shot
	try {
		const response = await chatCompletion({ ...body, model, messages, tools }, config);
		if (response.usage) await recordUsage(ctx, model, response.usage);
		// Even without tools, attribute cost to task if provided
		if (body.task_id && ctx.http && response.usage) {
			const baseUrl = (
				(ctx.site as { url?: string } | undefined)?.url ?? "http://localhost:4321"
			).replace(TRAILING_SLASH_RE, "");
			try {
				await ctx.http.fetch(`${baseUrl}/_emdash/api/plugins/tasks/cost.record`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						id: body.task_id,
						model,
						tokensIn: response.usage.prompt_tokens,
						tokensOut: response.usage.completion_tokens,
						source: "openrouter",
					}),
				});
			} catch {
				/* best effort */
			}
		}
		return { ok: true, response };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

// ── Automation action types ─────────────────────────────────────────────────

interface LlmChatAction {
	type: "llm:chat";
	model?: string;
	system?: string;
	prompt: string;
	temperature?: number;
	maxTokens?: number;
	kvKey?: string;
	agentId?: string;
	taskId?: string;
	useTools?: boolean;
}

interface LlmSummarizeAction {
	type: "llm:summarize";
	model?: string;
	input: string;
	prompt?: string;
	maxTokens?: number;
	kvKey?: string;
	taskId?: string;
}

interface LlmEmbedAction {
	type: "llm:embed";
	model?: string;
	input: string;
	kvKey: string;
}

interface LlmAgentAction {
	type: "llm:agent";
	agentId: string;
	taskId?: string;
	prompt: string;
	maxIterations?: number;
	kvKey?: string;
}

registerAction<LlmChatAction>("llm:chat", async (action, tokenCtx, ctx) => {
	const messages: ChatMessage[] = [];
	if (action.system)
		messages.push({ role: "system", content: await resolveTokens(action.system, tokenCtx) });
	messages.push({ role: "user", content: await resolveTokens(action.prompt, tokenCtx) });

	const result = await runAgentAwareChat(
		{
			body: {
				model: action.model,
				messages,
				temperature: action.temperature,
				max_tokens: action.maxTokens,
				agent_id: action.agentId,
				task_id: action.taskId ? await resolveTokens(action.taskId, tokenCtx) : undefined,
				useTools: action.useTools,
			},
		},
		ctx,
	);
	if (!result.ok) throw new Error(result.error);

	const response = result.response as Record<string, unknown>;
	const text =
		(response.message as ChatMessage | undefined)?.content ??
		(response as { choices?: Array<{ message: ChatMessage }> }).choices?.[0]?.message.content ??
		"";

	if (action.kvKey) {
		await ctx.kv.set(await resolveTokens(action.kvKey, tokenCtx), text);
	}
});

registerAction<LlmSummarizeAction>("llm:summarize", async (action, tokenCtx, ctx) => {
	const config = await getConfig(ctx);
	if (!config) throw new Error("OpenRouter: API key not configured");
	const model = action.model ?? (await getDefaultModel(ctx));
	const userPrompt =
		action.prompt ?? "Summarize the following content in 2-3 sentences. Be neutral and factual.";
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

registerAction<LlmAgentAction>("llm:agent", async (action, tokenCtx, ctx) => {
	const taskId = action.taskId ? await resolveTokens(action.taskId, tokenCtx) : undefined;
	const result = await runAgentAwareChat(
		{
			body: {
				messages: [{ role: "user", content: await resolveTokens(action.prompt, tokenCtx) }],
				agent_id: action.agentId,
				task_id: taskId,
				useTools: true,
			},
		},
		ctx,
	);
	if (!result.ok) throw new Error(result.error);
	if (action.kvKey) {
		const response = result.response as { message?: ChatMessage };
		const text = response.message?.content ?? "";
		await ctx.kv.set(await resolveTokens(action.kvKey, tokenCtx), text);
	}
});

// ── Block Kit admin ─────────────────────────────────────────────────────────

async function buildAdminPage(ctx: PluginContext) {
	const apiKey = await ctx.kv.get<string>(KEY_KV);
	const defaultModel = await getDefaultModel(ctx);
	const defaultEmbed = await getDefaultEmbeddingsModel(ctx);

	const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
	const recent = await ctx.storage.usage!.query({
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
	const recent = await ctx.storage.usage!.query({
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
			handler: async (_event: unknown, ctx: PluginContext) => {
				ctx.log.info(
					"OpenRouter installed (llm:chat, llm:summarize, llm:embed, llm:agent action types registered)",
				);
			},
		},
	},

	routes: {
		chat: {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const body = routeCtx.input as
					| (Partial<ChatCompletionInput> & {
							agent_id?: string;
							task_id?: string;
							useTools?: boolean;
					  })
					| null;
				if (!body || !body.messages) return { ok: false, error: "messages required" };
				return await runAgentAwareChat({ body }, ctx);
			},
		},

		complete: {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const body = routeCtx.input as {
					model?: string;
					prompt?: string;
					agent_id?: string;
					task_id?: string;
				} | null;
				if (!body || !body.prompt) return { ok: false, error: "prompt required" };
				const result = await runAgentAwareChat(
					{
						body: {
							model: body.model,
							messages: [{ role: "user", content: body.prompt }],
							agent_id: body.agent_id,
							task_id: body.task_id,
						},
					},
					ctx,
				);
				if (!result.ok) return result;
				const response = result.response as Record<string, unknown>;
				const text =
					(response.message as ChatMessage | undefined)?.content ??
					(response as { choices?: Array<{ message: ChatMessage }> }).choices?.[0]?.message
						.content ??
					"";
				return { ok: true, text, response };
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
				const body = routeCtx.input as {
					defaultModel?: string;
					defaultEmbeddingsModel?: string;
				} | null;
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
					const defaultModel = optionalString(v.defaultModel);
					const defaultEmbeddingsModel = optionalString(v.defaultEmbeddingsModel);
					if (defaultModel) await ctx.kv.set(DEFAULT_MODEL_KV, defaultModel);
					if (defaultEmbeddingsModel)
						await ctx.kv.set(DEFAULT_EMBED_MODEL_KV, defaultEmbeddingsModel);
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
