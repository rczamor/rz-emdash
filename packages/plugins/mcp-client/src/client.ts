/**
 * Minimal MCP HTTP client.
 *
 * The MCP spec uses JSON-RPC over HTTP. We send `tools/list` and
 * `tools/call`; everything else is out of scope for M6. The full SDK
 * (`@modelcontextprotocol/sdk`) is overkill for two methods and would
 * pull in transport machinery we don't need.
 */

import type { McpServerConfig, McpTool, McpToolCallResponse } from "./types.js";

let nextRequestId = 1;
function newRequestId(): number {
	return nextRequestId++;
}

function buildAuthHeaders(server: McpServerConfig): Record<string, string> {
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (server.auth?.kind === "bearer") {
		headers.Authorization = `Bearer ${server.auth.token}`;
	} else if (server.auth?.kind === "basic") {
		const token =
			typeof Buffer !== "undefined"
				? Buffer.from(`${server.auth.username}:${server.auth.password}`).toString("base64")
				: btoa(`${server.auth.username}:${server.auth.password}`);
		headers.Authorization = `Basic ${token}`;
	}
	return headers;
}

interface JsonRpcRequest {
	jsonrpc: "2.0";
	id: number;
	method: string;
	params?: unknown;
}

interface JsonRpcResponse<T> {
	jsonrpc: "2.0";
	id: number;
	result?: T;
	error?: { code: number; message: string; data?: unknown };
}

async function rpc<T>(
	server: McpServerConfig,
	method: string,
	params: unknown,
	fetchImpl: typeof fetch,
): Promise<T> {
	const body: JsonRpcRequest = {
		jsonrpc: "2.0",
		id: newRequestId(),
		method,
		params,
	};
	const res = await fetchImpl(server.url, {
		method: "POST",
		headers: buildAuthHeaders(server),
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		throw new Error(`MCP server "${server.name}" returned HTTP ${res.status}`);
	}
	const json = (await res.json()) as JsonRpcResponse<T>;
	if (json.error) {
		throw new Error(`MCP "${server.name}" ${method}: ${json.error.message}`);
	}
	if (json.result === undefined) {
		throw new Error(`MCP "${server.name}" ${method}: empty result`);
	}
	return json.result;
}

/** Discover the tools an MCP server exposes. */
export async function listTools(
	server: McpServerConfig,
	fetchImpl: typeof fetch = globalThis.fetch,
): Promise<McpTool[]> {
	const result = await rpc<{ tools: McpTool[] }>(server, "tools/list", {}, fetchImpl);
	return result.tools;
}

/** Invoke a tool on an MCP server. */
export async function callTool(
	server: McpServerConfig,
	name: string,
	args: Record<string, unknown>,
	fetchImpl: typeof fetch = globalThis.fetch,
): Promise<McpToolCallResponse> {
	return await rpc<McpToolCallResponse>(
		server,
		"tools/call",
		{ name, arguments: args },
		fetchImpl,
	);
}

/** Convenience: extract the first text content from an MCP response. */
export function extractText(response: McpToolCallResponse): string {
	const first = response.content?.find((c) => c.type === "text");
	return first?.text ?? "";
}
