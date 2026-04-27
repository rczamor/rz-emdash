/**
 * pgvector client — fetch wrappers for use by other plugins.
 */

import type { SearchResult } from "./types.js";

const TRAILING_SLASH_RE = /\/$/;

const BASE = "/_emdash/api/plugins/pgvector";

interface ClientOptions {
	fetch?: typeof fetch;
	baseUrl?: string;
}

function urlFor(path: string, options: ClientOptions): string {
	return (options.baseUrl ?? "").replace(TRAILING_SLASH_RE, "") + `${BASE}${path}`;
}

export async function searchByEmbedding(
	body: { embedding: number[]; k?: number; source_collection?: string },
	options: ClientOptions = {},
): Promise<SearchResult[]> {
	const fetchImpl = options.fetch ?? globalThis.fetch;
	const res = await fetchImpl(urlFor("/search", options), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!res.ok) return [];
	const json = (await res.json()) as { data?: { ok?: boolean; results?: SearchResult[] } };
	return json.data?.results ?? [];
}

export async function upsertEmbeddingHttp(
	body: {
		source_collection: string;
		source_id: string;
		model: string;
		embedding: number[];
		metadata?: Record<string, unknown>;
	},
	options: ClientOptions = {},
): Promise<{ ok: boolean; error?: string }> {
	const fetchImpl = options.fetch ?? globalThis.fetch;
	const res = await fetchImpl(urlFor("/upsert", options), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!res.ok) return { ok: false, error: `upsert returned ${res.status}` };
	const json = (await res.json()) as { data?: { ok?: boolean; error?: string } };
	return { ok: json.data?.ok ?? false, error: json.data?.error };
}
