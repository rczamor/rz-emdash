/**
 * Address — runtime entrypoint.
 *
 * Routes:
 *   GET   countries.list                     public — list available countries
 *   GET   countries.get?code=US              public — fetch country spec
 *   POST  validate                           public — validate an address payload
 *   POST  format                             public — format an address to a string
 *   POST  webformFields?country=US           admin  — generate webform fields snippet
 *   POST  admin                              Block Kit
 */

import { definePlugin } from "emdash";
import type { PluginContext } from "emdash";

import {
	addressFromSubmission,
	formatAddress,
	listCountries,
	validateAddress,
	webformFieldsForCountry,
} from "./util.js";
import { COUNTRIES } from "./countries.js";

interface RouteCtx {
	input: unknown;
	request: Request;
}

function getQueryParam(routeCtx: RouteCtx, key: string): string | undefined {
	return new URL(routeCtx.request.url).searchParams.get(key) ?? undefined;
}

async function buildAdminPage() {
	const list = listCountries();
	return {
		blocks: [
			{ type: "header", text: "Address — supported countries" },
			{
				type: "context",
				elements: [
					{
						type: "text",
						text: "Built-in country specs ship with the plugin. Plugins can register more at runtime via registerCountry().",
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
			handler: async () => {
				return { countries: listCountries() };
			},
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
				const body = routeCtx.input as { country?: string; address?: Record<string, string> } | null;
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
				const body = routeCtx.input as { country?: string; address?: Record<string, string> } | null;
				if (!body || !body.country || !body.address) {
					return { ok: false, error: "country + address required" };
				}
				return { ok: true, formatted: formatAddress(body.address, body.country) };
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
			handler: async (routeCtx: RouteCtx, _ctx: PluginContext) => {
				const interaction = routeCtx.input as { type?: string; page?: string };
				if (interaction.type === "page_load" && interaction.page === "/address") {
					return await buildAdminPage();
				}
				return { blocks: [] };
			},
		},
	},
});

// Re-export so consumers using `@emdash-cms/plugin-address/sandbox` can
// reach the helpers without a separate import path. The util package is
// the canonical path though.
export { addressFromSubmission };
