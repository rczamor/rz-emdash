/**
 * Brand client — pure helpers importable by OpenRouter / Agents.
 *
 * The key surface is `assembleBrandSystemBlock`: turn a Brand into a
 * markdown block suitable for prepending to a system prompt.
 */

import type { Brand } from "./types.js";

const TRAILING_SLASH_RE = /\/$/;

const BASE = "/_emdash/api/plugins/brand";

interface ClientOptions {
	fetch?: typeof fetch;
	baseUrl?: string;
}

function urlFor(path: string, options: ClientOptions): string {
	return (options.baseUrl ?? "").replace(TRAILING_SLASH_RE, "") + `${BASE}${path}`;
}

export async function getActiveBrand(
	options: ClientOptions & { locale?: string } = {},
): Promise<Brand | null> {
	const fetchImpl = options.fetch ?? globalThis.fetch;
	const params = new URLSearchParams();
	if (options.locale) params.set("locale", options.locale);
	const qs = params.toString();
	const res = await fetchImpl(urlFor(`/brands.active${qs ? `?${qs}` : ""}`, options));
	if (!res.ok) return null;
	const json = (await res.json()) as { data?: { ok?: boolean; brand?: Brand } };
	return json.data?.brand ?? null;
}

export async function getBrand(id: string, options: ClientOptions = {}): Promise<Brand | null> {
	const fetchImpl = options.fetch ?? globalThis.fetch;
	const res = await fetchImpl(urlFor(`/brands.get?id=${encodeURIComponent(id)}`, options));
	if (!res.ok) return null;
	const json = (await res.json()) as { data?: { ok?: boolean; brand?: Brand } };
	return json.data?.brand ?? null;
}

/**
 * Render a brand as a markdown block suitable for prepending to a
 * system prompt. Intentionally compact and well-structured so the
 * model can latch onto each section quickly.
 */
export function assembleBrandSystemBlock(brand: Brand): string {
	const lines: string[] = [];

	lines.push(`# Brand: ${brand.name}`);
	if (brand.locale) lines.push(`_Locale: ${brand.locale}_`);
	lines.push(`\n## Positioning\n\n${brand.positioning.trim()}`);

	if (brand.voice_attributes.length > 0) {
		lines.push(`\n## Voice attributes`);
		for (const v of brand.voice_attributes) {
			const intensity = v.intensity != null ? ` _(${v.intensity}/10)_` : "";
			const desc = v.description ? ` — ${v.description}` : "";
			lines.push(`- **${v.name}**${intensity}${desc}`);
		}
	}

	if (brand.tone_rules.length > 0) {
		lines.push(`\n## Tone rules`);
		for (const t of brand.tone_rules) {
			lines.push(`- _${t.context}_: ${t.guidance}`);
		}
	}

	if (brand.vocabulary.length > 0) {
		lines.push(`\n## Vocabulary`);
		for (const v of brand.vocabulary) {
			const avoid = v.avoid?.length ? ` (avoid: ${v.avoid.join(", ")})` : "";
			const why = v.rationale ? ` — ${v.rationale}` : "";
			lines.push(`- Use **"${v.preferred}"**${avoid}${why}`);
		}
	}

	if (brand.banned_phrases.length > 0) {
		lines.push(`\n## Never use`);
		for (const p of brand.banned_phrases) {
			lines.push(`- "${p}"`);
		}
	}

	if (brand.examples.length > 0) {
		lines.push(`\n## Examples`);
		for (const e of brand.examples) {
			lines.push(
				`- Good: "${e.good}"${e.bad ? ` · Bad: "${e.bad}"` : ""}${e.rationale ? ` — ${e.rationale}` : ""}`,
			);
		}
	}

	if (brand.notes) {
		lines.push(`\n## Notes\n\n${brand.notes.trim()}`);
	}

	return lines.join("\n");
}

/**
 * Quick rule-based check: does the input contain any banned phrases
 * from the brand? Returns the offending phrases. Useful as a cheap
 * pre-flight before publishing.
 *
 * Case-insensitive substring match. Doesn't catch paraphrases — for
 * that, use an LLM-judge check (out of scope for this plugin; build
 * an automation routine atop llm:chat).
 */
export function detectBannedPhrases(text: string, brand: Brand): string[] {
	if (!text || !brand.banned_phrases?.length) return [];
	const lower = text.toLowerCase();
	return brand.banned_phrases.filter((p) => lower.includes(p.toLowerCase()));
}
