/**
 * Pure helpers for pathauto — no plugin context, no I/O.
 */

import { resolveTokens } from "@emdash-cms/plugin-tokens/resolver";

export interface PathautoPattern {
	collection: string;
	pattern: string;
	maxLength?: number;
	lowercase?: boolean;
	onUpdate?: "regenerate" | "preserve";
}

export const DEFAULT_MAX_LENGTH = 100;
const COLLECTION_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const COMBINING_MARK_RE = /[̀-ͯ]/g;
const NON_SLUG_CHAR_RE = /[^A-Za-z0-9]+/g;
const SLUG_EDGE_DASH_RE = /^-+|-+$/g;

/**
 * If a `/` or `-` separator falls within the last `1 - SEPARATOR_BREAKPOINT_RATIO`
 * of the cut window, prefer cutting at the separator over a hard cut. With the
 * default 0.7, that means a separator must land past 70% of `maxLength` for us
 * to keep it; otherwise we fall back to a clean character-count truncation.
 */
export const SEPARATOR_BREAKPOINT_RATIO = 0.7;

export function isValidCollectionName(name: unknown): name is string {
	return typeof name === "string" && COLLECTION_NAME_RE.test(name);
}

export function trimSlug(slug: string, maxLength: number): string {
	if (slug.length <= maxLength) return slug;
	const cut = slug.slice(0, maxLength);
	const lastSep = Math.max(cut.lastIndexOf("/"), cut.lastIndexOf("-"));
	return lastSep > maxLength * SEPARATOR_BREAKPOINT_RATIO ? cut.slice(0, lastSep) : cut;
}

export function slugifySegment(s: string): string {
	return s
		.normalize("NFKD")
		.replace(COMBINING_MARK_RE, "")
		.replace(NON_SLUG_CHAR_RE, "-")
		.replace(SLUG_EDGE_DASH_RE, "");
}

/**
 * Resolve `pattern` against `content` and shape the result into a slug —
 * NFKD-fold each `/`-separated segment, lowercase (unless disabled), and
 * trim to `maxLength` while preferring to cut at a separator.
 */
export async function applyPatternPure(
	pattern: PathautoPattern,
	content: Record<string, unknown>,
): Promise<string | null> {
	const raw = await resolveTokens(pattern.pattern, { content });
	if (!raw) return null;
	const segments = raw
		.split("/")
		.map((s) => s.trim())
		.filter(Boolean);
	let slug = segments.map(slugifySegment).filter(Boolean).join("/");
	if (pattern.lowercase !== false) slug = slug.toLowerCase();
	slug = trimSlug(slug, pattern.maxLength ?? DEFAULT_MAX_LENGTH);
	return slug || null;
}
