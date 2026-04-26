/**
 * Pathauto Plugin for EmDash CMS
 *
 * Generates content slugs from per-collection token patterns. EmDash port of
 * Drupal's Pathauto module.
 *
 * Patterns are stored per collection in plugin storage. Example:
 *
 *   {
 *     "collection": "posts",
 *     "pattern": "{publishedAt|date:YYYY}/{title|slug}",
 *     "maxLength": 100,
 *     "lowercase": true,
 *     "onUpdate": "regenerate"
 *   }
 *
 * On `content:beforeSave` (for items in a collection that has a pattern),
 * the plugin resolves the pattern against the content and writes the
 * result to `content.slug`. Emdash core already handles auto-redirects
 * when a slug changes, so renames don't break old URLs.
 *
 * The plugin also exposes a `regenerate` route that bulk-rewrites slugs
 * for a collection — useful after a pattern change.
 */

import type { PluginDescriptor } from "emdash";

export interface PathautoPattern {
	collection: string;
	pattern: string;
	maxLength?: number;
	lowercase?: boolean;
	/**
	 * What to do when an existing item is saved.
	 *   - "regenerate" (default): always recompute the slug from the pattern
	 *   - "preserve":              keep the slug if one is set, only generate
	 *                              when missing
	 */
	onUpdate?: "regenerate" | "preserve";
}

export function pathautoPlugin(): PluginDescriptor {
	return {
		id: "pathauto",
		version: "0.0.1",
		format: "standard",
		entrypoint: "@emdash-cms/plugin-pathauto/sandbox",
		options: {},
		capabilities: ["read:content", "write:content"],
		storage: {
			patterns: { indexes: ["collection"] },
		},
		adminPages: [{ path: "/pathauto", label: "Pathauto", icon: "link" }],
	};
}
