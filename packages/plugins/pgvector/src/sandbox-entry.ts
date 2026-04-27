/**
 * pgvector — runtime entrypoint.
 *
 * Routes:
 *   POST  init                  Run schema setup for a given dimension
 *   POST  upsert                Insert / replace embedding for (collection, id, model)
 *   POST  upsert.bulk           Bulk variant — { inputs: [...] }
 *   POST  search                k-NN search by raw embedding (+ metadata filter)
 *   POST  search.byText         Embed text via the configured LLM gateway, then search
 *   POST  delete                Delete by (collection, id) [+ optional model + optional dimension]
 *   GET   list?source_collection=&limit=
 *   GET   stats                 Total + per-collection + per-dimension counts
 *
 *   POST  auto-embed.set        body: { collection, fields[], model, idField? }
 *   POST  auto-embed.unset      body: { collection }
 *   GET   auto-embed.list       all configured collections
 *
 *   POST  admin                 Block Kit
 *
 * Hooks:
 *   plugin:install   ensureSchema for default dim + register vector_search tool
 *   plugin:activate  re-discover existing dimensions
 *   content:afterSave  if collection has auto-embed config, embed + upsert
 */

import { registerTool } from "@emdash-cms/plugin-tools/registry";
import { definePlugin } from "emdash";
import type { PluginContext } from "emdash";

import {
	bulkUpsertEmbeddings,
	deleteEmbedding,
	discoverDimensions,
	ensureSchemaForDimension,
	getKnownDimensions,
	listEmbeddings,
	searchEmbeddings,
	statsByCollection,
	totalCount,
	upsertEmbedding,
} from "./db.js";
import type { AutoEmbedConfig, SearchInput, UpsertEmbeddingInput } from "./types.js";

const TRAILING_SLASH_RE = /\/$/;

interface RouteCtx {
	input: unknown;
	request: Request;
}

function getQueryParam(routeCtx: RouteCtx, key: string): string | undefined {
	return new URL(routeCtx.request.url).searchParams.get(key) ?? undefined;
}

function getDefaultDimension(): number {
	return Number(process.env.PGVECTOR_DIMENSION ?? "1536") || 1536;
}

function siteUrl(ctx: PluginContext): string {
	return ((ctx.site as { url?: string } | undefined)?.url ?? "http://localhost:4321").replace(
		TRAILING_SLASH_RE,
		"",
	);
}

/**
 * Resolve the route to use for `embeddings` calls. Defaults try, in
 * order: PGVECTOR_EMBED_ROUTE (env var override), the registered
 * tensorzero plugin, the registered openrouter plugin. Decouples
 * pgvector from any one LLM gateway — anything that exposes
 * `POST .../embeddings` returning `{ data: { ok, response: { data:
 * [{ embedding }], model } } }` works.
 */
function embedRoutes(): string[] {
	const override = process.env.PGVECTOR_EMBED_ROUTE;
	if (override) return [override.startsWith("/") ? override : `/${override}`];
	return [
		"/_emdash/api/plugins/tensorzero/embeddings",
		"/_emdash/api/plugins/openrouter/embeddings",
	];
}

async function embedTextViaGateway(
	text: string,
	model: string | undefined,
	ctx: PluginContext,
): Promise<{ embedding: number[]; model: string } | null> {
	if (!ctx.http) return null;
	for (const path of embedRoutes()) {
		try {
			const res = await ctx.http.fetch(`${siteUrl(ctx)}${path}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ input: text, model }),
			});
			if (!res.ok) continue;
			const json = (await res.json()) as {
				data?: {
					ok?: boolean;
					response?: { data?: Array<{ embedding: number[] }>; model: string };
				};
			};
			const data = json.data?.response;
			const embedding = data?.data?.[0]?.embedding;
			if (!embedding) continue;
			return { embedding, model: data.model };
		} catch (err) {
			ctx.log.warn("pgvector: gateway embed attempt failed", {
				path,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
	return null;
}

// ── Auto-embed config ──────────────────────────────────────────────────────

const AUTOEMBED_PREFIX = "auto_embed:";

async function setAutoEmbed(
	collection: string,
	config: AutoEmbedConfig,
	ctx: PluginContext,
): Promise<void> {
	await ctx.kv.set(`${AUTOEMBED_PREFIX}${collection}`, config);
}

async function getAutoEmbed(
	collection: string,
	ctx: PluginContext,
): Promise<AutoEmbedConfig | null> {
	return (await ctx.kv.get<AutoEmbedConfig>(`${AUTOEMBED_PREFIX}${collection}`)) ?? null;
}

async function unsetAutoEmbed(collection: string, ctx: PluginContext): Promise<boolean> {
	return await ctx.kv.delete(`${AUTOEMBED_PREFIX}${collection}`);
}

async function listAutoEmbed(
	ctx: PluginContext,
): Promise<Array<{ collection: string; config: AutoEmbedConfig }>> {
	const entries = await ctx.kv.list(AUTOEMBED_PREFIX);
	return entries.map((e) => ({
		collection: e.key.slice(AUTOEMBED_PREFIX.length),
		config: e.value as AutoEmbedConfig,
	}));
}

function buildEmbeddingInput(content: Record<string, unknown>, fields: string[]): string {
	const parts: string[] = [];
	for (const f of fields) {
		const v = content[f];
		if (v == null) continue;
		if (typeof v === "string") parts.push(v);
		else if (typeof v === "number" || typeof v === "boolean") parts.push(String(v));
		else parts.push(JSON.stringify(v));
	}
	return parts.join("\n\n");
}

// ── Tools registration ─────────────────────────────────────────────────────

registerTool({
	name: "vector_search",
	description:
		"Semantically search content via embeddings. Pass `text` to auto-embed and search; or pass an `embedding` array directly. Returns the top-k most similar items with cosine-similarity score.",
	parameters: {
		type: "object",
		properties: {
			text: {
				type: "string",
				description: "Query text — auto-embedded via configured LLM gateway",
			},
			embedding: {
				type: "array",
				items: { type: "number" },
				description: "Pre-computed embedding (alternative to text)",
			},
			source_collection: { type: "string" },
			k: { type: "number" },
			metadata: { type: "object", description: "JSONB containment filter" },
		},
	},
	capabilities: ["network:fetch"],
	handler: async (args, ctx) => {
		const k = typeof args.k === "number" ? args.k : 10;
		const filter: Record<string, unknown> | undefined =
			args.metadata && typeof args.metadata === "object"
				? (args.metadata as Record<string, unknown>)
				: undefined;
		const collection =
			typeof args.source_collection === "string" ? args.source_collection : undefined;

		let embedding: number[] | undefined;
		if (Array.isArray(args.embedding)) {
			embedding = args.embedding as number[];
		} else if (typeof args.text === "string" && args.text) {
			const embed = await embedTextViaGateway(args.text, undefined, ctx);
			if (!embed) throw new Error("Failed to embed query text via configured LLM gateway");
			embedding = embed.embedding;
		} else {
			throw new Error("vector_search needs either `text` or `embedding`");
		}

		return await searchEmbeddings({
			embedding,
			k,
			source_collection: collection,
			metadata: filter,
		});
	},
});

// ── Block Kit admin ────────────────────────────────────────────────────────

async function buildAdminPage(ctx: PluginContext) {
	let total = 0;
	let stats: Awaited<ReturnType<typeof statsByCollection>> = [];
	const dims = getKnownDimensions();
	let initialized = true;
	let initError: string | undefined;

	try {
		total = await totalCount();
		stats = await statsByCollection();
	} catch (err) {
		initialized = false;
		initError = err instanceof Error ? err.message : String(err);
	}

	const autoEmbed = await listAutoEmbed(ctx);
	const indexType = (process.env.PGVECTOR_INDEX_TYPE ?? "hnsw").toLowerCase();

	const blocks: unknown[] = [
		{ type: "header", text: "pgvector" },
		{
			type: "context",
			elements: [
				{
					type: "text",
					text: `Embedding store. Default dim: ${getDefaultDimension()}. Index type: ${indexType}. Discovered dims: ${dims.length > 0 ? dims.join(", ") : "(none yet)"}`,
				},
			],
		},
	];

	if (!initialized) {
		blocks.push({
			type: "banner",
			variant: "error",
			title: "Schema not initialized",
			description: `POST /init (or restart the plugin) to run CREATE EXTENSION + CREATE TABLE. Error: ${initError}`,
		});
		return { blocks };
	}

	blocks.push({
		type: "stats",
		stats: [
			{ label: "Total embeddings", value: String(total) },
			{ label: "Collections", value: String(stats.length) },
			{ label: "Dimensions", value: String(dims.length) },
			{ label: "Auto-embed configs", value: String(autoEmbed.length) },
		],
	});

	if (stats.length > 0) {
		blocks.push({ type: "header", text: "By collection" });
		blocks.push({
			type: "table",
			blockId: "pgvector-stats",
			columns: [
				{ key: "collection", label: "Collection", format: "text" },
				{ key: "count", label: "Count", format: "text" },
				{ key: "dims", label: "Dims", format: "text" },
			],
			rows: stats.map((s) => ({
				collection: s.collection,
				count: String(s.count),
				dims: Object.entries(s.byDimension)
					.map(([d, c]) => `${d}: ${c}`)
					.join(", "),
			})),
		});
	}

	if (autoEmbed.length > 0) {
		blocks.push({ type: "header", text: "Auto-embed configurations" });
		blocks.push({
			type: "table",
			blockId: "pgvector-autoembed",
			columns: [
				{ key: "collection", label: "Collection", format: "text" },
				{ key: "fields", label: "Fields", format: "text" },
				{ key: "model", label: "Model", format: "text" },
			],
			rows: autoEmbed.map((a) => ({
				collection: a.collection,
				fields: a.config.fields.join(", "),
				model: a.config.model,
			})),
		});
	}

	return { blocks };
}

// ── Plugin definition ──────────────────────────────────────────────────────

export default definePlugin({
	hooks: {
		"plugin:install": {
			handler: async (_event: unknown, ctx: PluginContext) => {
				try {
					await ensureSchemaForDimension(getDefaultDimension());
					await discoverDimensions();
					ctx.log.info("pgvector plugin installed (schema ready)");
				} catch (err) {
					ctx.log.error("pgvector: schema init failed on install", {
						error: err instanceof Error ? err.message : String(err),
					});
				}
			},
		},
		"plugin:activate": {
			handler: async (_event: unknown, ctx: PluginContext) => {
				try {
					await ensureSchemaForDimension(getDefaultDimension());
					await discoverDimensions();
				} catch (err) {
					ctx.log.warn("pgvector: schema init failed on activate", {
						error: err instanceof Error ? err.message : String(err),
					});
				}
			},
		},

		"content:afterSave": {
			handler: async (event: unknown, ctx: PluginContext) => {
				const collection = (event as { collection: string }).collection;
				const content = (event as { content: Record<string, unknown> }).content;
				const config = await getAutoEmbed(collection, ctx);
				if (!config) return;
				const idField = config.idField ?? "id";
				const sourceId = content[idField];
				if (typeof sourceId !== "string" || !sourceId) {
					ctx.log.warn("pgvector: auto-embed skipped — content has no id", { collection });
					return;
				}
				const text = buildEmbeddingInput(content, config.fields);
				if (!text.trim()) {
					ctx.log.info("pgvector: auto-embed skipped — empty input text", {
						collection,
						sourceId,
					});
					return;
				}
				const embed = await embedTextViaGateway(text, config.model, ctx);
				if (!embed) {
					ctx.log.warn("pgvector: auto-embed openrouter call failed", { collection, sourceId });
					return;
				}
				try {
					await upsertEmbedding({
						source_collection: collection,
						source_id: sourceId,
						model: embed.model,
						embedding: embed.embedding,
						metadata: { auto: true },
					});
				} catch (err) {
					ctx.log.error("pgvector: auto-embed upsert failed", {
						collection,
						sourceId,
						error: err instanceof Error ? err.message : String(err),
					});
				}
			},
		},
	},

	routes: {
		init: {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const body = routeCtx.input as { dimension?: number } | null;
				const dim = body?.dimension ?? getDefaultDimension();
				try {
					await ensureSchemaForDimension(dim);
					return { ok: true, dimension: dim, dimensionsKnown: getKnownDimensions() };
				} catch (err) {
					ctx.log.error("pgvector: init failed", {
						error: err instanceof Error ? err.message : String(err),
					});
					return { ok: false, error: err instanceof Error ? err.message : String(err) };
				}
			},
		},

		upsert: {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const body = routeCtx.input as UpsertEmbeddingInput | null;
				if (
					!body ||
					!body.source_collection ||
					!body.source_id ||
					!body.model ||
					!Array.isArray(body.embedding)
				) {
					return {
						ok: false,
						error: "source_collection, source_id, model, embedding required",
					};
				}
				try {
					const record = await upsertEmbedding(body);
					return { ok: true, record };
				} catch (err) {
					ctx.log.error("pgvector: upsert failed", {
						error: err instanceof Error ? err.message : String(err),
					});
					return { ok: false, error: err instanceof Error ? err.message : String(err) };
				}
			},
		},

		"upsert.bulk": {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const body = routeCtx.input as { inputs?: UpsertEmbeddingInput[] } | null;
				if (!body || !Array.isArray(body.inputs) || body.inputs.length === 0) {
					return { ok: false, error: "inputs[] required" };
				}
				try {
					const result = await bulkUpsertEmbeddings(body.inputs);
					return { ok: true, ...result };
				} catch (err) {
					ctx.log.error("pgvector: bulk upsert failed", {
						error: err instanceof Error ? err.message : String(err),
					});
					return { ok: false, error: err instanceof Error ? err.message : String(err) };
				}
			},
		},

		search: {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const body = routeCtx.input as SearchInput | null;
				if (!body || !Array.isArray(body.embedding)) {
					return { ok: false, error: "embedding required" };
				}
				try {
					const results = await searchEmbeddings(body);
					return { ok: true, results };
				} catch (err) {
					ctx.log.error("pgvector: search failed", {
						error: err instanceof Error ? err.message : String(err),
					});
					return { ok: false, error: err instanceof Error ? err.message : String(err) };
				}
			},
		},

		"search.byText": {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const body = routeCtx.input as {
					text?: string;
					model?: string;
					k?: number;
					source_collection?: string;
					metadata?: Record<string, unknown>;
				} | null;
				if (!body || !body.text) return { ok: false, error: "text required" };
				const embed = await embedTextViaGateway(body.text, body.model, ctx);
				if (!embed) return { ok: false, error: "Failed to embed text via openrouter" };
				try {
					const results = await searchEmbeddings({
						embedding: embed.embedding,
						k: body.k,
						source_collection: body.source_collection,
						metadata: body.metadata,
					});
					return { ok: true, results, model: embed.model };
				} catch (err) {
					return { ok: false, error: err instanceof Error ? err.message : String(err) };
				}
			},
		},

		delete: {
			handler: async (routeCtx: RouteCtx, _ctx: PluginContext) => {
				const body = routeCtx.input as {
					source_collection?: string;
					source_id?: string;
					model?: string;
					dimension?: number;
				} | null;
				if (!body || !body.source_collection || !body.source_id) {
					return { ok: false, error: "source_collection + source_id required" };
				}
				try {
					const removed = await deleteEmbedding(body.source_collection, body.source_id, {
						model: body.model,
						dimension: body.dimension,
					});
					return { ok: true, removed };
				} catch (err) {
					return { ok: false, error: err instanceof Error ? err.message : String(err) };
				}
			},
		},

		list: {
			handler: async (routeCtx: RouteCtx, _ctx: PluginContext) => {
				const source_collection = getQueryParam(routeCtx, "source_collection");
				const limit = Math.min(
					Math.max(parseInt(getQueryParam(routeCtx, "limit") ?? "100", 10) || 100, 1),
					500,
				);
				if (!source_collection) return { ok: false, error: "source_collection required" };
				try {
					const records = await listEmbeddings(source_collection, limit);
					return { ok: true, records };
				} catch (err) {
					return { ok: false, error: err instanceof Error ? err.message : String(err) };
				}
			},
		},

		stats: {
			handler: async (_routeCtx: RouteCtx, _ctx: PluginContext) => {
				try {
					const total = await totalCount();
					const byCollection = await statsByCollection();
					const dimensions = getKnownDimensions();
					return { ok: true, total, byCollection, dimensions };
				} catch (err) {
					return { ok: false, error: err instanceof Error ? err.message : String(err) };
				}
			},
		},

		"auto-embed.set": {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const body = routeCtx.input as {
					collection?: string;
					fields?: string[];
					model?: string;
					idField?: string;
				} | null;
				if (
					!body ||
					!body.collection ||
					!Array.isArray(body.fields) ||
					body.fields.length === 0 ||
					!body.model
				) {
					return { ok: false, error: "collection, fields[], model required" };
				}
				const config: AutoEmbedConfig = {
					fields: body.fields,
					model: body.model,
					idField: body.idField,
				};
				await setAutoEmbed(body.collection, config, ctx);
				return { ok: true, collection: body.collection, config };
			},
		},

		"auto-embed.unset": {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const body = routeCtx.input as { collection?: string } | null;
				if (!body || !body.collection) return { ok: false, error: "collection required" };
				const removed = await unsetAutoEmbed(body.collection, ctx);
				return { ok: true, removed };
			},
		},

		"auto-embed.list": {
			handler: async (_routeCtx: RouteCtx, ctx: PluginContext) => {
				const items = await listAutoEmbed(ctx);
				return { ok: true, items };
			},
		},

		admin: {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const interaction = routeCtx.input as { type?: string; page?: string };
				if (interaction.type === "page_load" && interaction.page === "/pgvector") {
					return await buildAdminPage(ctx);
				}
				return { blocks: [] };
			},
		},
	},
});
