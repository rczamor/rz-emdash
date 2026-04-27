/**
 * Address — runtime entrypoint.
 *
 * Routes:
 *   GET   countries.list                   public
 *   GET   countries.get?code=US            public
 *   POST  validate                         public
 *   POST  format                           public
 *   POST  geocode                          admin (network-bound)
 *   POST  reverseGeocode                   admin (network-bound)
 *   GET   webformFields?country=US         admin
 *   POST  admin                            Block Kit
 */

import { definePlugin } from "emdash";
import type { PluginContext } from "emdash";

import { COUNTRIES } from "./countries.js";
import { geocode, reverseGeocode } from "./geocoding.js";
import {
	addressFromSubmission,
	formatAddress,
	listCountries,
	validateAddress,
	webformFieldsForCountry,
} from "./util.js";

interface RouteCtx {
	input: unknown;
	request: Request;
}

function getQueryParam(routeCtx: RouteCtx, key: string): string | undefined {
	return new URL(routeCtx.request.url).searchParams.get(key) ?? undefined;
}

async function buildAdminPage(ctx: PluginContext) {
	const list = listCountries();
	const cacheCount = await ctx.storage.geocache!.count({});
	return {
		blocks: [
			{ type: "header", text: "Address" },
			{
				type: "stats",
				stats: [
					{ label: "Countries", value: String(list.length) },
					{ label: "Geocode cache entries", value: String(cacheCount) },
				],
			},
			{ type: "header", text: "Supported countries" },
			{
				type: "context",
				elements: [
					{
						type: "text",
						text: "Built-in country specs. Plugins can register more via registerCountry() at runtime.",
					},
				],
			},
			{
				type: "table",
				blockId: "address-countries",
				columns: [
					{ key: "code", label: "Code", format: "text" },
					{ key: "name", label: "Country", format: "text" },
					{ key: "fields", label: "Fields", format: "text" },
				],
				rows: list.map((c) => ({
					code: c.code,
					name: c.name,
					fields: String(COUNTRIES[c.code]?.fields.length ?? 0),
				})),
			},
		],
	};
}

export default definePlugin({
	hooks: {},

	routes: {
		"countries.list": {
			public: true,
			handler: async () => ({ countries: listCountries() }),
		},

		"countries.get": {
			public: true,
			handler: async (routeCtx: RouteCtx) => {
				const code = getQueryParam(routeCtx, "code");
				if (!code) return { ok: false, error: "code query param required" };
				const country = COUNTRIES[code];
				if (!country) return { ok: false, error: "Unknown country" };
				return { ok: true, country };
			},
		},

		validate: {
			public: true,
			handler: async (routeCtx: RouteCtx) => {
				const body = routeCtx.input as {
					country?: string;
					address?: Record<string, string>;
				} | null;
				if (!body || !body.country || !body.address) {
					return { ok: false, error: "country + address required" };
				}
				const errors = validateAddress(body.address, body.country);
				return { ok: errors.length === 0, errors };
			},
		},

		format: {
			public: true,
			handler: async (routeCtx: RouteCtx) => {
				const body = routeCtx.input as {
					country?: string;
					address?: Record<string, string>;
				} | null;
				if (!body || !body.country || !body.address) {
					return { ok: false, error: "country + address required" };
				}
				return { ok: true, formatted: formatAddress(body.address, body.country) };
			},
		},

		geocode: {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const body = routeCtx.input as {
					address?: Record<string, string>;
					country?: string;
					bypassCache?: boolean;
				} | null;
				if (!body || !body.address) {
					return { ok: false, error: "address required" };
				}
				try {
					const result = await geocode(
						body.address,
						{ country: body.country, bypassCache: body.bypassCache },
						ctx,
					);
					if (!result) return { ok: false, error: "No match" };
					return { ok: true, result };
				} catch (err) {
					return { ok: false, error: err instanceof Error ? err.message : String(err) };
				}
			},
		},

		reverseGeocode: {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const body = routeCtx.input as { lat?: number; lng?: number; bypassCache?: boolean } | null;
				if (!body || typeof body.lat !== "number" || typeof body.lng !== "number") {
					return { ok: false, error: "lat + lng required" };
				}
				try {
					const result = await reverseGeocode(
						body.lat,
						body.lng,
						{ bypassCache: body.bypassCache },
						ctx,
					);
					if (!result) return { ok: false, error: "No match" };
					return { ok: true, result };
				} catch (err) {
					return { ok: false, error: err instanceof Error ? err.message : String(err) };
				}
			},
		},

		webformFields: {
			handler: async (routeCtx: RouteCtx) => {
				const country = getQueryParam(routeCtx, "country");
				const prefix = getQueryParam(routeCtx, "prefix");
				if (!country) return { ok: false, error: "country query param required" };
				return { ok: true, fields: webformFieldsForCountry(country, { prefix }) };
			},
		},

		admin: {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const interaction = routeCtx.input as { type?: string; page?: string };
				if (interaction.type === "page_load" && interaction.page === "/address") {
					return await buildAdminPage(ctx);
				}
				return { blocks: [] };
			},
		},
	},
});

export { addressFromSubmission };
