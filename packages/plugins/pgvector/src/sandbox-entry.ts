/**
 * pgvector — runtime entrypoint.
 *
 * Routes:
 *   POST  init                  Idempotent — CREATE EXTENSION + CREATE TABLE + indexes
 *   POST  upsert                Insert / replace embedding for (collection, id, model)
 *   POST  search                k-NN search by raw embedding
 *   POST  search.byText         Embed text via openrouter, then search
 *   POST  delete                Delete by (collection, id) [+ optional model]
 *   GET   list?source_collection=&limit=
 *   GET   stats                 Total count + per-collection counts
 *   POST  admin                 Block Kit
 *
 * Hooks:
 *   plugin:install — runs `init` so the schema is ready on first boot
 */

import { definePlugin } from "emdash";
import type { PluginContext } from "emdash";

import {
	deleteEmbedding,
	ensureSchema,
	listEmbeddings,
	searchEmbeddings,
	statsByCollection,
	totalCount,
	upsertEmbedding,
} from "./db.js";
import type { SearchInput, UpsertEmbeddingInput } from "./types.js";

interface RouteCtx {
	input: unknown;
	request: Request;
}

function getQueryParam(routeCtx: RouteCtx, key: string): string | undefined {
	return new URL(routeCtx.request.url).searchParams.get(key) ?? undefined;
}

function getDimension(): number {
	return Number(process.env.PGVECTOR_DIMENSION ?? "1536") || 1536;
}

function siteUrl(ctx: PluginContext): string {
	return (((ctx.site as { url?: string } | undefined)?.url ?? "http://localhost:4321") as string).replace(/\/$/, "");
}

async function embedTextViaOpenRouter(
	text: string,
	model: string | undefined,
	ctx: PluginContext,
): Promise<{ embedding: number[]; model: string } | null> {
	if (!ctx.http) return null;
	try {
		const res = await ctx.http.fetch(
			`${siteUrl(ctx)}/_emdash/api/plugins/openrouter/embeddings`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ input: text, model }),
			},
		);
		if (!res.ok) return null;
		const json = (await res.json()) as {
			data?: { ok?: boolean; response?: { data?: Array<{ embedding: number[] }>; model: string } };
		};
		const data = json.data?.response;
		const embedding = data?.data?.[0]?.embedding;
		if (!embedding) return null;
		return { embedding, model: data!.model };
	} catch (err) {
		ctx.log.warn("pgvector: openrouter embed failed", {
			error: err instanceof Error ? err.message : String(err),
		});
		return null;
	}
}

async function buildAdminPage() {
	let total = 0;
	let stats: Awaited<ReturnType<typeof statsByCollection>> = [];
	let initialized = true;
	let initError: string | undefined;

	try {
		total = await totalCount();
		stats = await statsByCollection();
	} catch (err) {
		initialized = false;
		initError = err instanceof Error ? err.message : String(err);
	}

	const blocks: unknown[] = [
		{ type: "header", text: "pgvector" },
		{
			type: "context",
			elements: [
				{
					type: "text",
					text: `Embedding store. Dimension: ${getDimension()}. Index: HNSW with cosine distance.`,
				},
			],
		},
	];

	if (!initialized) {
		blocks.push({
			type: "banner",
			variant: "error",
			title: "Schema not initialized",
			description: `POST /_emdash/api/plugins/pgvector/init to run CREATE EXTENSION + CREATE TABLE. Error: ${initError}`,
		});
		return { blocks };
	}

	blocks.push({
		type: "stats",
		stats: [
			{ label: "Total embeddings", value: String(total) },
			{ label: "Collections", value: String(stats.length) },
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
			],
			rows: stats.map((s) => ({ collection: s.collection, count: String(s.count) })),
		});
	}

	return { blocks };
}

export default definePlugin({
	hooks: {
		"plugin:install": {
			handler: async (_event, ctx: PluginContext) => {
				try {
					await ensureSchema({ dimension: getDimension() });
					ctx.log.info("pgvector plugin installed (schema ready)");
				} catch (err) {
					ctx.log.error("pgvector: schema init failed on install", {
						error: err instanceof Error ? err.message : String(err),
					});
				}
			},
		},
		"plugin:activate": {
			handler: async (_event, ctx: PluginContext) => {
				try {
					await ensureSchema({ dimension: getDimension() });
				} catch (err) {
					ctx.log.warn("pgvector: schema init failed on activate", {
						error: err instanceof Error ? err.message : String(err),
					});
				}
			},
		},
	},

	routes: {
		init: {
			handler: async (_routeCtx: RouteCtx, ctx: PluginContext) => {
				try {
					await ensureSchema({ dimension: getDimension() });
					return { ok: true, dimension: getDimension() };
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
				if (!body || !body.source_collection || !body.source_id || !body.model || !Array.isArray(body.embedding)) {
					return { ok: false, error: "source_collection, source_id, model, embedding required" };
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
				const body = routeCtx.input as
					| { text?: string; model?: string; k?: number; source_collection?: string }
					| null;
				if (!body || !body.text) return { ok: false, error: "text required" };
				const embed = await embedTextViaOpenRouter(body.text, body.model, ctx);
				if (!embed) return { ok: false, error: "Failed to embed text via openrouter" };
				try {
					const results = await searchEmbeddings({
						embedding: embed.embedding,
						k: body.k,
						source_collection: body.source_collection,
					});
					return { ok: true, results, model: embed.model };
				} catch (err) {
					return { ok: false, error: err instanceof Error ? err.message : String(err) };
				}
			},
		},

		delete: {
			handler: async (routeCtx: RouteCtx, _ctx: PluginContext) => {
				const body = routeCtx.input as
					| { source_collection?: string; source_id?: string; model?: string }
					| null;
				if (!body || !body.source_collection || !body.source_id) {
					return { ok: false, error: "source_collection + source_id required" };
				}
				try {
					const removed = await deleteEmbedding(body.source_collection, body.source_id, body.model);
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
					return { ok: true, total, byCollection };
				} catch (err) {
					return { ok: false, error: err instanceof Error ? err.message : String(err) };
				}
			},
		},

		admin: {
			handler: async (routeCtx: RouteCtx, _ctx: PluginContext) => {
				const interaction = routeCtx.input as { type?: string; page?: string };
				if (interaction.type === "page_load" && interaction.page === "/pgvector") {
					return await buildAdminPage();
				}
				return { blocks: [] };
			},
		},
	},
});
