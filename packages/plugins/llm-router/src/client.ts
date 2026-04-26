/**
 * LLM Router client — fetch wrappers consumed by other plugins.
 */

const BASE = "/_emdash/api/plugins/llm-router";

interface ClientOptions {
	fetch?: typeof fetch;
	baseUrl?: string;
}

function urlFor(path: string, options: ClientOptions): string {
	return (options.baseUrl ?? "").replace(/\/$/, "") + `${BASE}${path}`;
}

export interface RouterStatus {
	configured: boolean;
	driver: string | null;
	host: string | null;
	hasApiKey: boolean;
	availableDrivers: string[];
}

export async function getStatus(options: ClientOptions = {}): Promise<RouterStatus | null> {
	const fetchImpl = options.fetch ?? globalThis.fetch;
	const res = await fetchImpl(urlFor("/status", options));
	if (!res.ok) return null;
	const json = (await res.json()) as { data?: RouterStatus };
	return json.data ?? null;
}

export async function chat(
	body: Record<string, unknown>,
	options: ClientOptions = {},
): Promise<{ ok: boolean; response?: unknown; error?: string }> {
	const fetchImpl = options.fetch ?? globalThis.fetch;
	const res = await fetchImpl(urlFor("/chat", options), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!res.ok) return { ok: false, error: `chat returned ${res.status}` };
	const json = (await res.json()) as { data?: { ok?: boolean; response?: unknown; error?: string } };
	return json.data ?? { ok: false, error: "Empty response" };
}

export async function embed(
	body: { input: string | string[]; model?: string },
	options: ClientOptions = {},
): Promise<{ ok: boolean; response?: { data?: Array<{ embedding: number[] }>; model: string }; error?: string }> {
	const fetchImpl = options.fetch ?? globalThis.fetch;
	const res = await fetchImpl(urlFor("/embeddings", options), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!res.ok) return { ok: false, error: `embeddings returned ${res.status}` };
	const json = (await res.json()) as {
		data?: { ok?: boolean; response?: { data?: Array<{ embedding: number[] }>; model: string }; error?: string };
	};
	return json.data ?? { ok: false, error: "Empty response" };
}
