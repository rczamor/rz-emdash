/**
 * Tokens Plugin for EmDash CMS
 *
 * EmDash port of Drupal's Tokens module. Two halves:
 *
 *   1. A pure resolver utility (`@emdash-cms/plugin-tokens/resolver`) that
 *      any plugin or any user code can import directly.
 *
 *        import { resolveTokens } from "@emdash-cms/plugin-tokens/resolver";
 *        await resolveTokens("Hello {user.name|upper}", { user: { name: "ada" } });
 *
 *   2. A registered EmDash plugin descriptor so the runtime is aware tokens
 *      are in use. The plugin itself currently has no hooks — it exists so
 *      the marketplace + admin can list it as installed.
 *
 * "Tokens that work in any field" requires core-level integration to scan
 * field values on save/render. That isn't possible from a plugin alone.
 * What we ship instead: the resolver utility, plus integration in
 * `@emdash-cms/plugin-webform` (email subject/body templates). Future
 * plugins (Pathauto-style URL patterns, Metatag templates, etc.) opt in
 * the same way.
 */

import type { PluginDescriptor } from "emdash";

export type { TokenContext, Formatter, ResolveOptions } from "./resolver.js";

export function tokensPlugin(): PluginDescriptor {
	return {
		id: "tokens",
		version: "0.0.1",
		format: "standard",
		entrypoint: "@emdash-cms/plugin-tokens/sandbox",
		options: {},
	};
}
