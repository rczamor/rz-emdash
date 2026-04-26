/**
 * Langfuse — runtime entrypoint.
 *
 * Routes:
 *   GET   status
 *   POST  trace                  body: trace fields → langfuse ingest
 *   POST  generation             body: generation fields → langfuse ingest
 *   POST  score                  body: score fields → langfuse ingest
 *   GET   prompts.get?name=&label=&version=
 *   POST  datasets.items         body: { dataset } → list dataset items
 *   POST  settings.setKeys       body: { host?, publicKey, secretKey }
 *   GET   settings
 *   POST  admin                  Block Kit
 *
 * Automation actions:
 *   langfuse:trace               Submit a trace
 *   langfuse:score               Attach a score (use on task:reviewed)
 *   langfuse:get-prompt          Fetch a versioned prompt → KV
 */

import { definePlugin } from "emdash";
import type { PluginContext } from "emdash";
import { registerAction } from "@emdash-cms/plugin-automations/registry";
import { resolveTokens } from "@emdash-cms/plugin-tokens/resolver";

import { getPrompt, ingest, listDatasetItems, type LangfuseConfig } from "./api.js";
import type {
	GenerationCreateBody,
	IngestionEvent,
	ScoreCreateBody,
	TraceCreateBody,
} from "./types.js";

interface RouteCtx {
	input: unknown;
	request: Request;
}

const HOST_KV = "settings:host";
const PK_KV = "settings:publicKey";
const SK_KV = "settings:secretKey";

const NOW = () => new Date().toISOString();

function newId(): string {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
		return crypto.randomUUID();
	}
	return `lf_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
}

function getQueryParam(routeCtx: RouteCtx, key: string): string | undefined {
	return new URL(routeCtx.request.url).searchParams.get(key) ?? undefined;
}

async function getConfig(ctx: PluginContext): Promise<LangfuseConfig | null> {
	const host = (await ctx.kv.get<string>(HOST_KV)) ?? process.env.LANGFUSE_HOST;
	const publicKey = (await ctx.kv.get<string>(PK_KV)) ?? process.env.LANGFUSE_PUBLIC_KEY;
	const secretKey = (await ctx.kv.get<string>(SK_KV)) ?? process.env.LANGFUSE_SECRET_KEY;
	if (!host || !publicKey || !secretKey) return null;
	return {
		host,
		publicKey,
		secretKey,
		fetchImpl: ctx.http?.fetch.bind(ctx.http),
	};
}

interface RecentTraceRecord {
	id: string;
	traceId: string;
	name: string;
	taskId?: string;
	agentId?: string;
	createdAt: string;
}

async function recordRecentTrace(
	traceId: string,
	name: string,
	metadata: Record<string, unknown> | undefined,
	ctx: PluginContext,
): Promise<void> {
	try {
		const id = newId();
		const record: RecentTraceRecord = {
			id,
			traceId,
			name,
			task_id: typeof metadata?.task_id === "string" ? metadata.task_id : undefined,
			agent_id: typeof metadata?.agent_id === "string" ? metadata.agent_id : undefined,
			createdAt: NOW(),
		} as unknown as RecentTraceRecord;
		await ctx.storage.recent_traces.put(id, record);
	} catch (err) {
		ctx.log.warn("Langfuse: failed to record recent trace", {
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

// ── Automation actions ──────────────────────────────────────────────────────

interface LangfuseTraceAction {
	type: "langfuse:trace";
	traceId?: string;
	name?: string;
	userId?: string;
	taskId?: string;
	metadata?: Record<string, unknown>;
	tags?: string[];
	input?: unknown;
	output?: unknown;
}

interface LangfuseScoreAction {
	type: "langfuse:score";
	traceId: string;
	name: string;
	value: number | string;
	comment?: string;
}

interface LangfuseGetPromptAction {
	type: "langfuse:get-prompt";
	name: string;
	label?: string;
	version?: number;
	kvKey: string;
}

registerAction<LangfuseTraceAction>("langfuse:trace", async (action, tokenCtx, ctx) => {
	const config = await getConfig(ctx);
	if (!config) throw new Error("Langfuse: not configured");
	const traceId = action.traceId
		? await resolveTokens(action.traceId, tokenCtx)
		: newId();
	const name = action.name ? await resolveTokens(action.name, tokenCtx) : "automation";
	const metadata = {
		...(action.metadata ?? {}),
		task_id: action.taskId ? await resolveTokens(action.taskId, tokenCtx) : undefined,
	};
	const event: IngestionEvent = {
		id: newId(),
		timestamp: NOW(),
		type: "trace-create",
		body: {
			id: traceId,
			name,
			userId: action.userId ? await resolveTokens(action.userId, tokenCtx) : undefined,
			metadata,
			tags: action.tags,
			input: action.input,
			output: action.output,
			timestamp: NOW(),
		},
	};
	await ingest([event], config);
	await recordRecentTrace(traceId, name, metadata, ctx);
});

registerAction<LangfuseScoreAction>("langfuse:score", async (action, tokenCtx, ctx) => {
	const config = await getConfig(ctx);
	if (!config) throw new Error("Langfuse: not configured");
	const traceId = await resolveTokens(action.traceId, tokenCtx);
	const event: IngestionEvent = {
		id: newId(),
		timestamp: NOW(),
		type: "score-create",
		body: {
			id: newId(),
			traceId,
			name: action.name,
			value: action.value,
			comment: action.comment ? await resolveTokens(action.comment, tokenCtx) : undefined,
		},
	};
	await ingest([event], config);
});

registerAction<LangfuseGetPromptAction>("langfuse:get-prompt", async (action, tokenCtx, ctx) => {
	const config = await getConfig(ctx);
	if (!config) throw new Error("Langfuse: not configured");
	const prompt = await getPrompt(
		action.name,
		{ label: action.label, version: action.version },
		config,
	);
	if (!prompt) throw new Error(`Prompt "${action.name}" not found`);
	const kvKey = await resolveTokens(action.kvKey, tokenCtx);
	await ctx.kv.set(kvKey, prompt);
});

// ── Block Kit admin ─────────────────────────────────────────────────────────

async function buildAdminPage(ctx: PluginContext) {
	const config = await getConfig(ctx);
	const host = (await ctx.kv.get<string>(HOST_KV)) ?? process.env.LANGFUSE_HOST ?? "(not set)";

	const blocks: unknown[] = [
		{ type: "header", text: "Langfuse" },
		{
			type: "stats",
			stats: [
				{ label: "Configured", value: config ? "Yes" : "No" },
				{ label: "Host", value: host || "—" },
			],
		},
	];

	if (!config) {
		blocks.push({
			type: "banner",
			variant: "alert",
			title: "Not configured",
			description:
				"Set LANGFUSE_HOST + LANGFUSE_PUBLIC_KEY + LANGFUSE_SECRET_KEY env vars, or POST to /langfuse/settings.setKeys.",
		});
	}

	const recent = await ctx.storage.recent_traces.query({
		orderBy: { createdAt: "desc" },
		limit: 25,
	});
	if (recent.items.length > 0) {
		blocks.push({ type: "header", text: "Recent traces" });
		blocks.push({
			type: "table",
			blockId: "langfuse-recent",
			columns: [
				{ key: "name", label: "Name", format: "text" },
				{ key: "traceId", label: "Trace id", format: "text" },
				{ key: "task_id", label: "Task", format: "text" },
				{ key: "createdAt", label: "When", format: "relative_time" },
			],
			rows: recent.items.map((i) => {
				const r = i.data as RecentTraceRecord;
				return {
					name: r.name,
					traceId: r.traceId.slice(0, 12),
					task_id: r.task_id ?? "",
					createdAt: r.createdAt,
				};
			}),
		});
	}

	return { blocks };
}

async function buildRecentWidget(ctx: PluginContext) {
	const recent = await ctx.storage.recent_traces.query({
		orderBy: { createdAt: "desc" },
		limit: 5,
	});
	return {
		blocks: [
			{ type: "header", text: "Recent traces" },
			recent.items.length === 0
				? { type: "context", elements: [{ type: "text", text: "No traces yet" }] }
				: {
						type: "table",
						blockId: "langfuse-recent-widget",
						columns: [
							{ key: "name", label: "Name", format: "text" },
							{ key: "createdAt", label: "When", format: "relative_time" },
						],
						rows: recent.items.map((i) => {
							const r = i.data as RecentTraceRecord;
							return { name: r.name, createdAt: r.createdAt };
						}),
					},
		],
	};
}

// ── Plugin definition ───────────────────────────────────────────────────────

export default definePlugin({
	hooks: {
		"plugin:install": {
			handler: async (_event, ctx: PluginContext) => {
				ctx.log.info(
					"Langfuse plugin installed (langfuse:trace / langfuse:score / langfuse:get-prompt actions registered)",
				);
			},
		},
	},

	routes: {
		status: {
			handler: async (_routeCtx: RouteCtx, ctx: PluginContext) => {
				const config = await getConfig(ctx);
				const host = (await ctx.kv.get<string>(HOST_KV)) ?? process.env.LANGFUSE_HOST;
				return {
					ok: true,
					configured: Boolean(config),
					host: host ?? null,
				};
			},
		},

		trace: {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const body = routeCtx.input as
					| {
							traceId?: string;
							name?: string;
							userId?: string;
							sessionId?: string;
							metadata?: Record<string, unknown>;
							tags?: string[];
							input?: unknown;
							output?: unknown;
					  }
					| null;
				if (!body) return { ok: false, error: "Body required" };
				const config = await getConfig(ctx);
				if (!config) return { ok: false, error: "Langfuse not configured" };
				const traceId = body.traceId ?? newId();
				const traceBody: TraceCreateBody = {
					id: traceId,
					name: body.name,
					userId: body.userId,
					sessionId: body.sessionId,
					metadata: body.metadata,
					tags: body.tags,
					input: body.input,
					output: body.output,
					timestamp: NOW(),
				};
				try {
					await ingest(
						[{ id: newId(), timestamp: NOW(), type: "trace-create", body: traceBody }],
						config,
					);
					await recordRecentTrace(traceId, body.name ?? "trace", body.metadata, ctx);
					return { ok: true, traceId };
				} catch (err) {
					return { ok: false, error: err instanceof Error ? err.message : String(err) };
				}
			},
		},

		generation: {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const body = routeCtx.input as Partial<GenerationCreateBody> | null;
				if (!body || !body.traceId) return { ok: false, error: "traceId required" };
				const config = await getConfig(ctx);
				if (!config) return { ok: false, error: "Langfuse not configured" };
				const generationId = body.id ?? newId();
				try {
					await ingest(
						[
							{
								id: newId(),
								timestamp: NOW(),
								type: "generation-create",
								body: { ...body, id: generationId } as GenerationCreateBody,
							},
						],
						config,
					);
					return { ok: true, generationId };
				} catch (err) {
					return { ok: false, error: err instanceof Error ? err.message : String(err) };
				}
			},
		},

		score: {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const body = routeCtx.input as Partial<ScoreCreateBody> | null;
				if (!body || !body.traceId || !body.name || body.value == null) {
					return { ok: false, error: "traceId, name, value required" };
				}
				const config = await getConfig(ctx);
				if (!config) return { ok: false, error: "Langfuse not configured" };
				const scoreId = body.id ?? newId();
				try {
					await ingest(
						[
							{
								id: newId(),
								timestamp: NOW(),
								type: "score-create",
								body: { ...body, id: scoreId } as ScoreCreateBody,
							},
						],
						config,
					);
					return { ok: true, scoreId };
				} catch (err) {
					return { ok: false, error: err instanceof Error ? err.message : String(err) };
				}
			},
		},

		"prompts.get": {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const name = getQueryParam(routeCtx, "name");
				const label = getQueryParam(routeCtx, "label");
				const versionStr = getQueryParam(routeCtx, "version");
				const version = versionStr ? parseInt(versionStr, 10) : undefined;
				if (!name) return { ok: false, error: "name required" };
				const config = await getConfig(ctx);
				if (!config) return { ok: false, error: "Langfuse not configured" };
				try {
					const prompt = await getPrompt(name, { label, version }, config);
					if (!prompt) return { ok: false, error: "Not found" };
					return { ok: true, prompt };
				} catch (err) {
					return { ok: false, error: err instanceof Error ? err.message : String(err) };
				}
			},
		},

		"datasets.items": {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const body = routeCtx.input as { dataset?: string } | null;
				if (!body?.dataset) return { ok: false, error: "dataset required" };
				const config = await getConfig(ctx);
				if (!config) return { ok: false, error: "Langfuse not configured" };
				try {
					const items = await listDatasetItems(body.dataset, config);
					return { ok: true, items };
				} catch (err) {
					return { ok: false, error: err instanceof Error ? err.message : String(err) };
				}
			},
		},

		"settings.setKeys": {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const body = routeCtx.input as
					| { host?: string; publicKey?: string; secretKey?: string }
					| null;
				if (!body) return { ok: false, error: "Body required" };
				if (body.host) await ctx.kv.set(HOST_KV, body.host);
				if (body.publicKey) await ctx.kv.set(PK_KV, body.publicKey);
				if (body.secretKey) await ctx.kv.set(SK_KV, body.secretKey);
				return { ok: true };
			},
		},

		settings: {
			handler: async (_routeCtx: RouteCtx, ctx: PluginContext) => {
				const host = (await ctx.kv.get<string>(HOST_KV)) ?? process.env.LANGFUSE_HOST;
				return {
					ok: true,
					host: host ?? null,
					hasPublicKey: Boolean((await ctx.kv.get<string>(PK_KV)) ?? process.env.LANGFUSE_PUBLIC_KEY),
					hasSecretKey: Boolean((await ctx.kv.get<string>(SK_KV)) ?? process.env.LANGFUSE_SECRET_KEY),
				};
			},
		},

		admin: {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const interaction = routeCtx.input as {
					type?: string;
					page?: string;
					widget?: string;
				};
				if (interaction.type === "page_load" && interaction.page === "/langfuse") {
					return await buildAdminPage(ctx);
				}
				if (interaction.type === "widget_load" && interaction.widget === "langfuse-recent") {
					return await buildRecentWidget(ctx);
				}
				return { blocks: [] };
			},
		},
	},
});
