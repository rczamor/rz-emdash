/**
 * Langfuse client — lightweight fetch wrappers used by other plugins
 * (e.g. OpenRouter for inline trace dispatch).
 */

const BASE = "/_emdash/api/plugins/langfuse";

interface ClientOptions {
	fetch?: typeof fetch;
	baseUrl?: string;
}

function urlFor(path: string, options: ClientOptions): string {
	return (options.baseUrl ?? "").replace(/\/$/, "") + `${BASE}${path}`;
}

export interface SubmitTraceInput {
	traceId?: string;
	name?: string;
	userId?: string;
	sessionId?: string;
	metadata?: Record<string, unknown>;
	tags?: string[];
	input?: unknown;
	output?: unknown;
}

export interface SubmitGenerationInput {
	traceId: string;
	generationId?: string;
	name?: string;
	model?: string;
	input?: unknown;
	output?: unknown;
	usage?: { input?: number; output?: number; total?: number };
	startTime?: string;
	endTime?: string;
	level?: "DEBUG" | "DEFAULT" | "WARNING" | "ERROR";
	statusMessage?: string;
	metadata?: Record<string, unknown>;
}

export interface SubmitScoreInput {
	traceId: string;
	name: string;
	value: number | string;
	comment?: string;
	observationId?: string;
}

export async function submitTrace(
	body: SubmitTraceInput,
	options: ClientOptions = {},
): Promise<{ ok: boolean; traceId?: string; error?: string }> {
	const fetchImpl = options.fetch ?? globalThis.fetch;
	const res = await fetchImpl(urlFor("/trace", options), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!res.ok) return { ok: false, error: `langfuse/trace returned ${res.status}` };
	const json = (await res.json()) as { data?: { ok?: boolean; traceId?: string; error?: string } };
	return json.data ?? { ok: false, error: "Empty response" };
}

export async function submitGeneration(
	body: SubmitGenerationInput,
	options: ClientOptions = {},
): Promise<{ ok: boolean; generationId?: string; error?: string }> {
	const fetchImpl = options.fetch ?? globalThis.fetch;
	const res = await fetchImpl(urlFor("/generation", options), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!res.ok) return { ok: false, error: `langfuse/generation returned ${res.status}` };
	const json = (await res.json()) as { data?: { ok?: boolean; generationId?: string; error?: string } };
	return json.data ?? { ok: false, error: "Empty response" };
}

export async function submitScore(
	body: SubmitScoreInput,
	options: ClientOptions = {},
): Promise<{ ok: boolean; scoreId?: string; error?: string }> {
	const fetchImpl = options.fetch ?? globalThis.fetch;
	const res = await fetchImpl(urlFor("/score", options), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!res.ok) return { ok: false, error: `langfuse/score returned ${res.status}` };
	const json = (await res.json()) as { data?: { ok?: boolean; scoreId?: string; error?: string } };
	return json.data ?? { ok: false, error: "Empty response" };
}
