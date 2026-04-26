/**
 * Tokens — runtime entrypoint.
 *
 * The plugin currently has no hooks of its own. Its value is the exported
 * resolver utility at `@emdash-cms/plugin-tokens/resolver` which other
 * plugins import directly. This file exists so the standard plugin format
 * is satisfied (entrypoint must export a default `definePlugin(...)`).
 */

import { definePlugin } from "emdash";

export default definePlugin({
	hooks: {},
	routes: {},
});
