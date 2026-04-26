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

export function isValidCollectionName(name: unknown): name is string {
	return typeof name === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(name);
}

export function trimSlug(slug: string, maxLength: number): string {
	if (slug.length <= maxLength) return slug;
	const cut = slug.slice(0, maxLength);
	const lastSep = Math.max(cut.lastIndexOf("/"), cut.lastIndexOf("-"));
	return lastSep > maxLength * 0.7 ? cut.slice(0, lastSep) : cut;
}

export function slugifySegment(s: string): string {
	return s
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.replace(/[^A-Za-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

export async function applyPatternPure(
	pattern: PathautoPattern,
	content: Record<string, unknown>,
): Promise<string | null> {
	const raw = await resolveTokens(pattern.pattern, { content });
	if (!raw) return null;
	const segments = raw.split("/").map((s) => s.trim()).filter(Boolean);
	const slugParts = segments.map(slugifySegment);
	let slug = slugParts.filter(Boolean).join("/");
	if (pattern.lowercase !== false) slug = slug.toLowerCase();
	const max = pattern.maxLength ?? DEFAULT_MAX_LENGTH;
	slug = trimSlug(slug, max);
	return slug || null;
}
