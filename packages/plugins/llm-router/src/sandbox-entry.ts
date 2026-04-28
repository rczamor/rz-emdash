/**
 * LLM Router — runtime entrypoint.
 *
 * Routes:
 *   POST  chat                             body: { model?, messages, … } + agent_id?, task_id?, useTools?
 *   POST  complete                         sugar: { model?, prompt }
 *   POST  embeddings                       body: { model?, input }
 *   GET   models                           list models (via active driver)
 *
 *   GET   status                           { configured, driver, host, hasApiKey, availableDrivers }
 *   GET   settings
 *   POST  settings.save                    body: { defaultModel?, defaultEmbeddingsModel? }
 *
 *   POST  native/<driver>/<route>          provider-specific surfaces
 *
 *   POST  admin                            Block Kit
 *
 * Active driver chosen at startup. Override with LLM_ROUTER_DRIVER env
 * var. Defaults to first driver whose detect() returns true (order:
 * tensorzero, openrouter, litellm).
 */

import { registerAction } from "@emdash-cms/plugin-automations/registry";
import { resolveTokens } from "@emdash-cms/plugin-tokens/resolver";
import { definePlugin } from "emdash";
import type { PluginContext } from "emdash";

import { runChatLoop, extractText } from "./chat-loop.js";
import {
	getDriver,
	listDrivers,
	registerDriver,
	resolveActiveDriver,
	type Driver,
	type DriverHandlers,
} from "./driver.js";
import { litellmDriver } from "./drivers/litellm.js";
import { openrouterDriver } from "./drivers/openrouter.js";
import { tensorzeroDriver } from "./drivers/tensorzero.js";
import { checkQuota, compileAgentSystemPrompt, fetchAgentToolsForOpenAI } from "./task-context.js";
import type { ChatCompletionInput, ChatMessage } from "./types.js";

const TRAILING_SLASH_RE = /\/$/;

// Register built-in drivers in detection priority order.
// User can override with LLM_ROUTER_DRIVER env var.
registerDriver(tensorzeroDriver);
registerDriver(openrouterDriver);
registerDriver(litellmDriver);

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

function getActiveDriver(): { driver: Driver; handlers: DriverHandlers } | null {
	const driver = resolveActiveDriver(process.env);
	if (!driver) return null;
	const config = driver.configFromEnv(process.env);
	try {
		const handlers = driver.build(config);
		return { driver, handlers };
	} catch {
		return null;
	}
}

async function getDefaultModel(ctx: PluginContext): Promise<string> {
	const stored = await ctx.kv.get<string>(DEFAULT_MODEL_KV);
	if (stored) return stored;
	const active = getActiveDriver();
	return active?.driver.defaults?.chatModel ?? "anthropic/claude-haiku-4-5";
}

async function getDefaultEmbeddingsModel(ctx: PluginContext): Promise<string> {
	const stored = await ctx.kv.get<string>(DEFAULT_EMBED_MODEL_KV);
	if (stored) return stored;
	const active = getActiveDriver();
	return active?.driver.defaults?.embeddingsModel ?? "openai/text-embedding-3-small";
}

async function recordUsage(
	ctx: PluginContext,
	driverId: string,
	model: string,
	usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number },
): Promise<void> {
	const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	await ctx.storage.usage!.put(id, {
		driver: driverId,
		model,
		promptTokens: usage.prompt_tokens ?? 0,
		completionTokens: usage.completion_tokens ?? 0,
		totalTokens: usage.total_tokens ?? 0,
		createdAt: NOW(),
	});
}

// ── Agent-aware chat ────────────────────────────────────────────────────────

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

	const active = getActiveDriver();
	if (!active)
		return {
			ok: false,
			error: "No LLM driver configured (set TENSORZERO_HOST / OPENROUTER_API_KEY / LITELLM_HOST)",
		};

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

	if (body.task_id) {
		const actor = body.agent_id ? `agent:${body.agent_id}` : "system";
		const quota = await checkQuota(
			{ actor, taskId: body.task_id, estimatedTokensIn: 0, estimatedTokensOut: body.max_tokens },
			ctx,
		);
		if (!quota.ok) return { ok: false, error: quota.reason ?? "Quota exceeded" };
	}

	if ((tools && tools.length > 0) || body.useTools) {
		if (!tools && body.useTools) {
			tools = await fetchAgentToolsForOpenAI(body.agent_id, ctx);
		}
		const result = await runChatLoop(
			{
				completionInput: { ...body, model, messages, tools },
				driverId: active.driver.id,
				handlers: active.handlers,
				taskId: body.task_id,
				agentId: body.agent_id,
			},
			ctx,
		);
		await recordUsage(ctx, active.driver.id, model, {
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
				driver: active.driver.id,
			},
		};
	}

	const fetchImpl = ctx.http?.fetch.bind(ctx.http) ?? globalThis.fetch;
	try {
		const response = await active.handlers.chatCompletion(
			{ ...body, model, messages, tools },
			fetchImpl,
		);
		if (response.usage) await recordUsage(ctx, active.driver.id, model, response.usage);
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
						source: `llm-router:${active.driver.id}`,
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

// ── Automation actions ─────────────────────────────────────────────────────

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
	const active = getActiveDriver();
	if (!active) throw new Error("No LLM driver configured");
	const fetchImpl = ctx.http?.fetch.bind(ctx.http) ?? globalThis.fetch;
	const model = action.model ?? (await getDefaultModel(ctx));
	const userPrompt =
		action.prompt ?? "Summarize the following content in 2-3 sentences. Be neutral and factual.";
	const inputText = await resolveTokens(action.input, tokenCtx);
	const response = await active.handlers.chatCompletion(
		{
			model,
			messages: [
				{ role: "system", content: userPrompt },
				{ role: "user", content: inputText },
			],
			max_tokens: action.maxTokens ?? 300,
		},
		fetchImpl,
	);
	if (response.usage) await recordUsage(ctx, active.driver.id, model, response.usage);
	if (action.kvKey) {
		await ctx.kv.set(await resolveTokens(action.kvKey, tokenCtx), extractText(response));
	}
});

registerAction<LlmEmbedAction>("llm:embed", async (action, tokenCtx, ctx) => {
	const active = getActiveDriver();
	if (!active) throw new Error("No LLM driver configured");
	const fetchImpl = ctx.http?.fetch.bind(ctx.http) ?? globalThis.fetch;
	const model = action.model ?? (await getDefaultEmbeddingsModel(ctx));
	const inputText = await resolveTokens(action.input, tokenCtx);
	const response = await active.handlers.embeddings({ model, input: inputText }, fetchImpl);
	if (response.usage)
		await recordUsage(ctx, active.driver.id, model, { total_tokens: response.usage.total_tokens });
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

// ── Native routes dispatch ──────────────────────────────────────────────────

async function handleNativeRoute(
	driverId: string,
	routeName: string,
	body: unknown,
	ctx: PluginContext,
): Promise<unknown> {
	const driver = getDriver(driverId);
	if (!driver) return { ok: false, error: `Unknown driver: ${driverId}` };
	const route = driver.nativeRoutes?.find((r) => r.name === routeName);
	if (!route)
		return { ok: false, error: `Driver "${driverId}" has no native route "${routeName}"` };
	const fetchImpl = ctx.http?.fetch.bind(ctx.http) ?? globalThis.fetch;
	try {
		return await route.handler(body, fetchImpl, ctx);
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

// ── Block Kit admin ─────────────────────────────────────────────────────────

async function buildAdminPage(ctx: PluginContext) {
	const active = getActiveDriver();
	const allDrivers = listDrivers();
	const defaultModel = await getDefaultModel(ctx);
	const defaultEmbed = await getDefaultEmbeddingsModel(ctx);

	const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
	const recent = await ctx.storage.usage!.query({
		orderBy: { createdAt: "desc" },
		limit: 1000,
	});
	const last24 = recent.items
		.map((i) => i.data as { totalTokens: number; createdAt: string; model: string; driver: string })
		.filter((u) => u.createdAt >= oneDayAgo);
	const totalTokens = last24.reduce((sum, u) => sum + (u.totalTokens ?? 0), 0);
	const callCount = last24.length;

	const blocks: unknown[] = [
		{ type: "header", text: "LLM Router" },
		{
			type: "stats",
			stats: [
				{ label: "Active driver", value: active?.driver.name ?? "(none)" },
				{ label: "Calls 24h", value: String(callCount) },
				{ label: "Tokens 24h", value: String(totalTokens) },
				{ label: "Drivers available", value: String(allDrivers.length) },
			],
		},
	];

	if (!active) {
		blocks.push({
			type: "banner",
			variant: "alert",
			title: "No driver active",
			description: `Set one of: TENSORZERO_HOST, OPENROUTER_API_KEY, LITELLM_HOST. Or override with LLM_ROUTER_DRIVER=<id>.`,
		});
	} else {
		blocks.push({
			type: "fields",
			fields: [
				{ label: "Driver id", value: active.driver.id },
				{
					label: "Native routes",
					value: (active.driver.nativeRoutes ?? []).map((r) => r.name).join(", ") || "—",
				},
			],
		});
	}

	blocks.push({
		type: "header",
		text: "Drivers",
	});
	blocks.push({
		type: "table",
		blockId: "llm-router-drivers",
		columns: [
			{ key: "id", label: "Driver", format: "text" },
			{ key: "name", label: "Name", format: "text" },
			{ key: "active", label: "Active", format: "badge" },
			{ key: "detected", label: "Detected from env", format: "badge" },
			{ key: "native", label: "Native routes", format: "text" },
		],
		rows: allDrivers.map((d) => ({
			id: d.id,
			name: d.name,
			active: active?.driver.id === d.id ? "Active" : "",
			detected: d.detect(process.env) ? "Yes" : "",
			native: (d.nativeRoutes ?? []).map((r) => r.name).join(", ") || "—",
		})),
	});

	blocks.push({ type: "header", text: "Defaults" });
	blocks.push({
		type: "form",
		block_id: "llm-router-defaults",
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
	});

	blocks.push({ type: "header", text: "Recent calls" });
	blocks.push({
		type: "table",
		blockId: "llm-router-usage",
		columns: [
			{ key: "driver", label: "Driver", format: "text" },
			{ key: "model", label: "Model", format: "text" },
			{ key: "tokens", label: "Tokens", format: "text" },
			{ key: "createdAt", label: "When", format: "relative_time" },
		],
		rows: last24.slice(0, 20).map((u) => ({
			driver: u.driver ?? "—",
			model: u.model,
			tokens: String(u.totalTokens),
			createdAt: u.createdAt,
		})),
	});

	return { blocks };
}

async function buildUsageWidget(ctx: PluginContext) {
	const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
	const recent = await ctx.storage.usage!.query({
		orderBy: { createdAt: "desc" },
		limit: 500,
	});
	const last24 = recent.items
		.map((i) => i.data as { totalTokens: number; createdAt: string })
		.filter((u) => u.createdAt >= oneDayAgo);
	const totalTokens = last24.reduce((sum, u) => sum + (u.totalTokens ?? 0), 0);
	const active = getActiveDriver();
	return {
		blocks: [
			{ type: "header", text: "LLM usage — 24h" },
			{
				type: "stats",
				stats: [
					{ label: "Driver", value: active?.driver.name ?? "(none)" },
					{ label: "Calls", value: String(last24.length) },
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
				const active = getActiveDriver();
				ctx.log.info(
					`LLM Router installed. ${active ? `Active driver: ${active.driver.name}.` : "No driver active — set TENSORZERO_HOST / OPENROUTER_API_KEY / LITELLM_HOST."} llm:chat / llm:summarize / llm:embed / llm:agent action types registered.`,
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
				const active = getActiveDriver();
				if (!active) return { ok: false, error: "No LLM driver configured" };
				const fetchImpl = ctx.http?.fetch.bind(ctx.http) ?? globalThis.fetch;
				const model = body.model ?? (await getDefaultEmbeddingsModel(ctx));
				try {
					const response = await active.handlers.embeddings(
						{ model, input: body.input },
						fetchImpl,
					);
					if (response.usage)
						await recordUsage(ctx, active.driver.id, model, {
							total_tokens: response.usage.total_tokens,
						});
					return { ok: true, response };
				} catch (err) {
					return { ok: false, error: err instanceof Error ? err.message : String(err) };
				}
			},
		},

		models: {
			handler: async (_routeCtx: RouteCtx, ctx: PluginContext) => {
				const active = getActiveDriver();
				if (!active) return { ok: false, error: "No LLM driver configured" };
				const fetchImpl = ctx.http?.fetch.bind(ctx.http) ?? globalThis.fetch;
				try {
					const models = await active.handlers.listModels(fetchImpl);
					return { ok: true, driver: active.driver.id, models };
				} catch (err) {
					return { ok: false, error: err instanceof Error ? err.message : String(err) };
				}
			},
		},

		// ── Native ───────────────────────────────────────────────────────

		"native.dispatch": {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const body = routeCtx.input as { driver?: string; route?: string; body?: unknown } | null;
				if (!body || !body.driver || !body.route) {
					return { ok: false, error: "driver + route required" };
				}
				return await handleNativeRoute(body.driver, body.route, body.body ?? {}, ctx);
			},
		},

		// ── Settings ─────────────────────────────────────────────────────

		status: {
			handler: async (_routeCtx: RouteCtx, ctx: PluginContext) => {
				const active = getActiveDriver();
				const config = active ? active.driver.configFromEnv(process.env) : null;
				return {
					ok: true,
					configured: Boolean(active),
					driver: active?.driver.id ?? null,
					host: config?.host ?? null,
					hasApiKey: Boolean(config?.apiKey),
					availableDrivers: listDrivers().map((d) => d.id),
					defaultModel: await getDefaultModel(ctx),
					defaultEmbeddingsModel: await getDefaultEmbeddingsModel(ctx),
				};
			},
		},

		settings: {
			handler: async (_routeCtx: RouteCtx, ctx: PluginContext) => {
				const active = getActiveDriver();
				return {
					ok: true,
					driver: active?.driver.id ?? null,
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

		admin: {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const interaction = routeCtx.input as {
					type?: string;
					page?: string;
					widget?: string;
					action_id?: string;
					values?: Record<string, unknown>;
				};
				if (interaction.type === "page_load" && interaction.page === "/llm-router") {
					return await buildAdminPage(ctx);
				}
				if (interaction.type === "widget_load" && interaction.widget === "llm-router-usage") {
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
