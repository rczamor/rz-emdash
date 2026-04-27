/**
 * Brand — runtime entrypoint.
 *
 * Routes:
 *   POST  brands.create         CreateBrandInput
 *   GET   brands.get?id=
 *   GET   brands.active?locale= (returns the active brand for a locale)
 *   GET   brands.list
 *   POST  brands.update         UpdateBrandInput
 *   POST  brands.activate       { id } — flips this one active, deactivates others in same locale
 *   POST  brands.delete         { id }
 *   POST  brands.check          { text, brandId? } — banned-phrases scan
 *   POST  admin                 Block Kit
 */

import { definePlugin } from "emdash";
import type { PluginContext, WhereClause, WhereValue } from "emdash";

import { detectBannedPhrases } from "./client.js";
import type { Brand, CreateBrandInput, UpdateBrandInput } from "./types.js";

const BRAND_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

interface RouteCtx {
	input: unknown;
	request: Request;
}

const NOW = () => new Date().toISOString();

function getQueryParam(routeCtx: RouteCtx, key: string): string | undefined {
	return new URL(routeCtx.request.url).searchParams.get(key) ?? undefined;
}

function isValidId(id: unknown): id is string {
	return typeof id === "string" && BRAND_ID_RE.test(id);
}

async function loadBrand(id: string, ctx: PluginContext): Promise<Brand | null> {
	const v = await ctx.storage.brands!.get(id);
	return (v as Brand | null) ?? null;
}

async function persistBrand(brand: Brand, ctx: PluginContext): Promise<void> {
	await ctx.storage.brands!.put(brand.id, brand);
}

async function listBrands(filter: WhereClause | undefined, ctx: PluginContext): Promise<Brand[]> {
	const result = await ctx.storage.brands!.query({
		where: filter,
		orderBy: { created_at: "desc" },
		limit: 200,
	});
	return result.items.map((i) => i.data as Brand);
}

async function findActive(locale: string | undefined, ctx: PluginContext): Promise<Brand | null> {
	const filter: Record<string, WhereValue> = { active: true };
	if (locale) filter.locale = locale;
	const result = await ctx.storage.brands!.query({
		where: filter,
		orderBy: { created_at: "desc" },
		limit: 1,
	});
	return (result.items[0]?.data as Brand | null) ?? null;
}

async function createBrand(input: CreateBrandInput, ctx: PluginContext): Promise<Brand> {
	if (!isValidId(input.id)) throw new Error("Invalid id");
	if (!input.name || !input.positioning) throw new Error("name and positioning are required");
	if (await ctx.storage.brands!.exists(input.id)) {
		throw new Error("Brand with that id already exists");
	}
	const brand: Brand = {
		id: input.id,
		locale: input.locale,
		name: input.name,
		positioning: input.positioning,
		voice_attributes: input.voice_attributes ?? [],
		tone_rules: input.tone_rules ?? [],
		vocabulary: input.vocabulary ?? [],
		banned_phrases: input.banned_phrases ?? [],
		examples: input.examples ?? [],
		notes: input.notes,
		active: input.active ?? false,
		created_at: NOW(),
		updated_at: NOW(),
	};
	await persistBrand(brand, ctx);
	return brand;
}

async function updateBrand(input: UpdateBrandInput, ctx: PluginContext): Promise<Brand> {
	if (!isValidId(input.id)) throw new Error("Invalid id");
	const brand = await loadBrand(input.id, ctx);
	if (!brand) throw new Error("Not found");
	if (input.name !== undefined) brand.name = input.name;
	if (input.locale !== undefined) brand.locale = input.locale;
	if (input.positioning !== undefined) brand.positioning = input.positioning;
	if (input.voice_attributes !== undefined) brand.voice_attributes = input.voice_attributes;
	if (input.tone_rules !== undefined) brand.tone_rules = input.tone_rules;
	if (input.vocabulary !== undefined) brand.vocabulary = input.vocabulary;
	if (input.banned_phrases !== undefined) brand.banned_phrases = input.banned_phrases;
	if (input.examples !== undefined) brand.examples = input.examples;
	if (input.notes !== undefined) brand.notes = input.notes;
	if (input.active !== undefined) brand.active = input.active;
	brand.updated_at = NOW();
	await persistBrand(brand, ctx);
	return brand;
}

async function activateBrand(id: string, ctx: PluginContext): Promise<Brand> {
	const brand = await loadBrand(id, ctx);
	if (!brand) throw new Error("Not found");
	// Deactivate other brands in the same locale.
	const peers = await listBrands(brand.locale ? { locale: brand.locale } : undefined, ctx);
	for (const p of peers) {
		if (p.id !== brand.id && p.active) {
			p.active = false;
			p.updated_at = NOW();
			await persistBrand(p, ctx);
		}
	}
	brand.active = true;
	brand.updated_at = NOW();
	await persistBrand(brand, ctx);
	return brand;
}

// ── Admin views ─────────────────────────────────────────────────────────────

interface AdminInteraction {
	type?: string;
	page?: string;
	action_id?: string;
	value?: string;
	values?: Record<string, unknown>;
}

function viewListPage(brands: Brand[]) {
	const blocks: unknown[] = [
		{ type: "header", text: "Brand" },
		{
			type: "context",
			elements: [
				{
					type: "text",
					text: "Editorial voice + tone + vocabulary. The active brand is auto-injected into agent system prompts via @emdash-cms/plugin-brand/client.",
				},
			],
		},
	];

	if (brands.length === 0) {
		blocks.push({
			type: "banner",
			variant: "default",
			title: "No brand defined yet",
			description: "Create one via POST /_emdash/api/plugins/brand/brands.create",
		});
		return { blocks };
	}

	blocks.push({
		type: "table",
		blockId: "brands-list",
		columns: [
			{ key: "id", label: "ID", format: "text" },
			{ key: "name", label: "Name", format: "text" },
			{ key: "locale", label: "Locale", format: "text" },
			{ key: "active", label: "Active", format: "badge" },
			{ key: "voice", label: "Voice attrs", format: "text" },
			{ key: "vocab", label: "Vocab", format: "text" },
			{ key: "banned", label: "Banned", format: "text" },
		],
		rows: brands.map((b) => ({
			id: b.id,
			name: b.name,
			locale: b.locale ?? "—",
			active: b.active ? "Active" : "",
			voice: String(b.voice_attributes.length),
			vocab: String(b.vocabulary.length),
			banned: String(b.banned_phrases.length),
		})),
	});

	for (const b of brands) {
		blocks.push({
			type: "actions",
			elements: [
				{ type: "context", elements: [{ type: "text", text: b.id }] },
				...(b.active
					? []
					: [
							{
								type: "button",
								text: "Activate",
								action_id: "activate_brand",
								value: b.id,
								style: "primary",
							},
						]),
				{
					type: "button",
					text: "Delete",
					action_id: "delete_brand",
					value: b.id,
					style: "danger",
					confirm: {
						title: "Delete brand?",
						text: `${b.id} will be removed.`,
						confirm: "Delete",
						deny: "Cancel",
					},
				},
			],
		});
	}

	return { blocks };
}

async function buildAdminPage(ctx: PluginContext) {
	const brands = await listBrands(undefined, ctx);
	return viewListPage(brands);
}

// ── Plugin definition ───────────────────────────────────────────────────────

export default definePlugin({
	hooks: {
		"plugin:install": {
			handler: async (_event: unknown, ctx: PluginContext) => {
				ctx.log.info("Brand plugin installed");
			},
		},
	},

	routes: {
		"brands.create": {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				try {
					const brand = await createBrand(routeCtx.input as CreateBrandInput, ctx);
					return { ok: true, brand };
				} catch (err) {
					return { ok: false, error: err instanceof Error ? err.message : String(err) };
				}
			},
		},

		"brands.get": {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const id = getQueryParam(routeCtx, "id");
				if (!isValidId(id)) return { ok: false, error: "id required" };
				const brand = await loadBrand(id, ctx);
				if (!brand) return { ok: false, error: "Not found" };
				return { ok: true, brand };
			},
		},

		"brands.active": {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const locale = getQueryParam(routeCtx, "locale");
				const brand = await findActive(locale, ctx);
				if (!brand) return { ok: false, error: "No active brand" };
				return { ok: true, brand };
			},
		},

		"brands.list": {
			handler: async (_routeCtx: RouteCtx, ctx: PluginContext) => {
				const brands = await listBrands(undefined, ctx);
				return { brands };
			},
		},

		"brands.update": {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				try {
					const brand = await updateBrand(routeCtx.input as UpdateBrandInput, ctx);
					return { ok: true, brand };
				} catch (err) {
					return { ok: false, error: err instanceof Error ? err.message : String(err) };
				}
			},
		},

		"brands.activate": {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const body = routeCtx.input as { id?: unknown } | null;
				if (!body || !isValidId(body.id)) return { ok: false, error: "id required" };
				try {
					const brand = await activateBrand(body.id, ctx);
					return { ok: true, brand };
				} catch (err) {
					return { ok: false, error: err instanceof Error ? err.message : String(err) };
				}
			},
		},

		"brands.delete": {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const body = routeCtx.input as { id?: unknown } | null;
				if (!body || !isValidId(body.id)) return { ok: false, error: "id required" };
				const removed = await ctx.storage.brands!.delete(body.id);
				return { ok: true, removed };
			},
		},

		"brands.check": {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const body = routeCtx.input as { text?: string; brandId?: string; locale?: string } | null;
				if (!body || !body.text) return { ok: false, error: "text required" };
				const brand = body.brandId
					? await loadBrand(body.brandId, ctx)
					: await findActive(body.locale, ctx);
				if (!brand) return { ok: false, error: "No matching brand" };
				const offending = detectBannedPhrases(body.text, brand);
				return {
					ok: offending.length === 0,
					offending,
					brandId: brand.id,
				};
			},
		},

		admin: {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const interaction = routeCtx.input as AdminInteraction;

				if (interaction.type === "page_load" && interaction.page === "/brand") {
					return await buildAdminPage(ctx);
				}

				if (
					interaction.type === "block_action" &&
					interaction.action_id === "activate_brand" &&
					isValidId(interaction.value)
				) {
					try {
						await activateBrand(interaction.value, ctx);
						return {
							...(await buildAdminPage(ctx)),
							toast: { message: "Activated", type: "success" },
						};
					} catch (err) {
						return {
							...(await buildAdminPage(ctx)),
							toast: { message: err instanceof Error ? err.message : String(err), type: "error" },
						};
					}
				}

				if (
					interaction.type === "block_action" &&
					interaction.action_id === "delete_brand" &&
					isValidId(interaction.value)
				) {
					await ctx.storage.brands!.delete(interaction.value);
					return { ...(await buildAdminPage(ctx)), toast: { message: "Deleted", type: "success" } };
				}

				return { blocks: [] };
			},
		},
	},
});
