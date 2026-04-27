/**
 * Pathauto — runtime entrypoint.
 *
 * Hook:
 *   content:beforeSave  — generates slug from pattern when collection has one
 *
 * Routes:
 *   GET   patterns.list                admin
 *   GET   patterns.get?collection=<c>  admin
 *   POST  patterns.upsert              admin
 *   POST  patterns.delete              admin
 *   POST  regenerate                   admin — bulk rewrite slugs for a collection
 *   POST  admin                        Block Kit
 */

import { definePlugin } from "emdash";
import type { PluginContext } from "emdash";

import {
	applyPatternPure,
	DEFAULT_MAX_LENGTH,
	isValidCollectionName,
	type PathautoPattern,
} from "./pure.js";

interface RouteCtx {
	input: unknown;
	request: Request;
}

function getQueryParam(routeCtx: RouteCtx, key: string): string | undefined {
	return new URL(routeCtx.request.url).searchParams.get(key) ?? undefined;
}

async function applyPattern(
	pattern: PathautoPattern,
	content: Record<string, unknown>,
	ctx: PluginContext,
): Promise<string | null> {
	try {
		return await applyPatternPure(pattern, content);
	} catch (err) {
		ctx.log.error("Pathauto: failed to resolve pattern", {
			collection: pattern.collection,
			pattern: pattern.pattern,
			error: err instanceof Error ? err.message : String(err),
		});
		return null;
	}
}

async function buildAdminPage(ctx: PluginContext) {
	const result = await ctx.storage.patterns!.query({
		orderBy: { collection: "asc" },
		limit: 200,
	});
	return {
		blocks: [
			{ type: "header", text: "Pathauto patterns" },
			{
				type: "context",
				elements: [
					{
						type: "text",
						text: "Patterns are managed via the API. Use the @emdash-cms/plugin-tokens syntax — e.g. {publishedAt|date:YYYY}/{title|slug}",
					},
				],
			},
			{
				type: "table",
				blockId: "pathauto-patterns",
				columns: [
					{ key: "collection", label: "Collection", format: "text" },
					{ key: "pattern", label: "Pattern", format: "text" },
					{ key: "onUpdate", label: "On update", format: "badge" },
					{ key: "maxLength", label: "Max", format: "text" },
				],
				rows: result.items.map((item) => {
					const p = item.data as PathautoPattern;
					return {
						collection: p.collection,
						pattern: p.pattern,
						onUpdate: p.onUpdate ?? "regenerate",
						maxLength: String(p.maxLength ?? DEFAULT_MAX_LENGTH),
					};
				}),
			},
		],
	};
}

export default definePlugin({
	hooks: {
		"content:beforeSave": {
			handler: async (
				event: { collection: string; content: Record<string, unknown> },
				ctx: PluginContext,
			) => {
				const pattern = (await ctx.storage.patterns!.get(
					event.collection,
				)) as PathautoPattern | null;
				if (!pattern) return;

				const onUpdate = pattern.onUpdate ?? "regenerate";
				const content = event.content as Record<string, unknown> & { slug?: unknown };
				if (onUpdate === "preserve" && typeof content.slug === "string" && content.slug) {
					return;
				}

				const slug = await applyPattern(pattern, content, ctx);
				if (!slug) return;

				return { ...content, slug };
			},
		},
	},

	routes: {
		"patterns.list": {
			handler: async (_routeCtx: RouteCtx, ctx: PluginContext) => {
				const result = await ctx.storage.patterns!.query({
					orderBy: { collection: "asc" },
					limit: 500,
				});
				return { patterns: result.items.map((i) => i.data) };
			},
		},

		"patterns.get": {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const collection = getQueryParam(routeCtx, "collection");
				if (!isValidCollectionName(collection)) {
					return { ok: false, error: "Missing or invalid collection" };
				}
				const pattern = await ctx.storage.patterns!.get(collection);
				if (!pattern) return { ok: false, error: "No pattern for this collection" };
				return { ok: true, pattern };
			},
		},

		"patterns.upsert": {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const body = routeCtx.input as Partial<PathautoPattern> | null;
				if (!body || !isValidCollectionName(body.collection)) {
					return { ok: false, error: "Invalid collection" };
				}
				if (typeof body.pattern !== "string" || body.pattern.trim() === "") {
					return { ok: false, error: "Pattern required" };
				}
				const pattern: PathautoPattern = {
					collection: body.collection,
					pattern: body.pattern,
					maxLength: typeof body.maxLength === "number" ? body.maxLength : undefined,
					lowercase: body.lowercase,
					onUpdate: body.onUpdate ?? "regenerate",
				};
				await ctx.storage.patterns!.put(pattern.collection, pattern);
				return { ok: true, pattern };
			},
		},

		"patterns.delete": {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const body = routeCtx.input as { collection?: unknown } | null;
				if (!body || !isValidCollectionName(body.collection)) {
					return { ok: false, error: "Invalid collection" };
				}
				const removed = await ctx.storage.patterns!.delete(body.collection);
				return { ok: true, removed };
			},
		},

		regenerate: {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const body = routeCtx.input as { collection?: unknown } | null;
				if (!body || !isValidCollectionName(body.collection)) {
					return { ok: false, error: "Invalid collection" };
				}
				const pattern = (await ctx.storage.patterns!.get(
					body.collection,
				)) as PathautoPattern | null;
				if (!pattern) return { ok: false, error: "No pattern set for this collection" };
				if (!ctx.content) return { ok: false, error: "Content access unavailable" };

				let updated = 0;
				let cursor: string | undefined;
				do {
					const page = await ctx.content.list(body.collection, {
						limit: 100,
						cursor,
					});
					for (const item of page.items) {
						const slug = await applyPattern(
							pattern,
							item as unknown as Record<string, unknown>,
							ctx,
						);
						if (!slug || slug === (item as { slug?: string }).slug) continue;
						try {
							await ctx.content.update!(body.collection, (item as { id: string }).id, { slug });
							updated++;
						} catch (err) {
							ctx.log.warn("Pathauto regenerate: skipped item", {
								id: (item as { id: string }).id,
								error: err instanceof Error ? err.message : String(err),
							});
						}
					}
					cursor = page.cursor;
				} while (cursor);
				return { ok: true, updated };
			},
		},

		admin: {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const interaction = routeCtx.input as { type?: string; page?: string };
				if (interaction.type === "page_load" && interaction.page === "/pathauto") {
					return await buildAdminPage(ctx);
				}
				return { blocks: [] };
			},
		},
	},
});
