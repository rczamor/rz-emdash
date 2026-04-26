/**
 * Design system client — fetch wrappers used by OpenRouter / Agents
 * to inject the design system block into agent prompts.
 */

import type { ParsedDesignSystem } from "./types.js";

const BASE = "/_emdash/api/plugins/design-system";

interface ClientOptions {
	fetch?: typeof fetch;
	baseUrl?: string;
}

function urlFor(path: string, options: ClientOptions): string {
	return (options.baseUrl ?? "").replace(/\/$/, "") + `${BASE}${path}`;
}

export async function getCachedDesign(
	options: ClientOptions = {},
): Promise<ParsedDesignSystem | null> {
	const fetchImpl = options.fetch ?? globalThis.fetch;
	const res = await fetchImpl(urlFor("/design.get", options));
	if (!res.ok) return null;
	const json = (await res.json()) as { data?: { ok?: boolean; design?: ParsedDesignSystem } };
	return json.data?.design ?? null;
}

export async function getDesignSystemPrompt(
	options: ClientOptions = {},
): Promise<string> {
	const fetchImpl = options.fetch ?? globalThis.fetch;
	const res = await fetchImpl(urlFor("/design.systemPrompt", options));
	if (!res.ok) return "";
	const json = (await res.json()) as { data?: { ok?: boolean; markdown?: string } };
	return json.data?.markdown ?? "";
}

export async function postDesignSource(
	source: string,
	options: ClientOptions = {},
): Promise<{ ok: boolean; error?: string; warningCount?: number }> {
	const fetchImpl = options.fetch ?? globalThis.fetch;
	const res = await fetchImpl(urlFor("/design.parse", options), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ source }),
	});
	if (!res.ok) return { ok: false, error: `design.parse returned ${res.status}` };
	const json = (await res.json()) as {
		data?: { ok?: boolean; report?: { findings: { level: string }[] } };
	};
	return {
		ok: Boolean(json.data?.ok),
		warningCount: json.data?.report?.findings.filter((f) => f.level === "warning").length ?? 0,
	};
}
