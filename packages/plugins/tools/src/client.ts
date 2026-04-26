/**
 * Tools client utilities — fetch wrappers around the plugin's HTTP
 * routes for use by OpenRouter and other consumers.
 */

import type { OpenAITool } from "./types.js";

const BASE = "/_emdash/api/plugins/tools";

interface ClientOptions {
	fetch?: typeof fetch;
	baseUrl?: string;
}

function urlFor(path: string, options: ClientOptions): string {
	return (options.baseUrl ?? "").replace(/\/$/, "") + `${BASE}${path}`;
}

export async function fetchOpenAISpec(
	options: ClientOptions & { agentId?: string; allowList?: string[] } = {},
): Promise<OpenAITool[]> {
	const fetchImpl = options.fetch ?? globalThis.fetch;
	const params = new URLSearchParams();
	if (options.agentId) params.set("agent_id", options.agentId);
	if (options.allowList) params.set("allow", options.allowList.join(","));
	const qs = params.toString();
	const res = await fetchImpl(urlFor(`/tools.openaiSpec${qs ? `?${qs}` : ""}`, options));
	if (!res.ok) return [];
	const json = (await res.json()) as { data?: { tools?: OpenAITool[] } };
	return json.data?.tools ?? [];
}

export interface InvokeOptions {
	taskId?: string;
}

export interface InvokeResponse {
	ok: boolean;
	tool: string;
	output?: unknown;
	error?: string;
	durationMs?: number;
}

export async function invokeTool(
	name: string,
	args: Record<string, unknown>,
	options: ClientOptions & InvokeOptions = {},
): Promise<InvokeResponse> {
	const fetchImpl = options.fetch ?? globalThis.fetch;
	const res = await fetchImpl(urlFor("/tools.invoke", options), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ name, arguments: args, taskId: options.taskId }),
	});
	if (!res.ok) return { ok: false, tool: name, error: `tools.invoke returned ${res.status}` };
	const json = (await res.json()) as { data?: InvokeResponse };
	return json.data ?? { ok: false, tool: name, error: "Empty response" };
}
