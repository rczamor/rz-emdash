/**
 * MCP HTTP client — JSON-RPC over POST.
 */

import { describe, expect, it, vi } from "vitest";

import { callTool, extractText, listTools } from "../src/client.js";
import { bridgedToolName } from "../src/tool-bridge.js";
import type { McpServerConfig } from "../src/types.js";

const SERVER: McpServerConfig = {
	id: "srv1",
	name: "test",
	url: "https://mcp.example.com/rpc",
	auth: { kind: "bearer", token: "secret" },
	created_at: "2026-04-29T00:00:00Z",
	updated_at: "2026-04-29T00:00:00Z",
};

function jsonRpcResponse<T>(id: number, result: T): Response {
	return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

function jsonRpcError(id: number, message: string): Response {
	return new Response(
		JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32603, message } }),
		{ status: 200, headers: { "Content-Type": "application/json" } },
	);
}

describe("listTools", () => {
	it("sends tools/list and returns the tools array", async () => {
		let captured: { url: string; init: RequestInit } | undefined;
		const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
			captured = { url: String(url), init: init! };
			const body = JSON.parse(init!.body as string) as { id: number };
			return jsonRpcResponse(body.id, {
				tools: [{ name: "search", description: "Search the index" }],
			});
		}) as typeof fetch;

		const tools = await listTools(SERVER, fetchFn);
		expect(tools).toEqual([{ name: "search", description: "Search the index" }]);
		expect(captured?.url).toBe(SERVER.url);
		const headers = captured?.init.headers as Record<string, string>;
		expect(headers["Content-Type"]).toBe("application/json");
		expect(headers.Authorization).toBe("Bearer secret");
		const body = JSON.parse(captured!.init.body as string) as { method: string };
		expect(body.method).toBe("tools/list");
	});

	it("uses Basic auth when configured", async () => {
		let auth: string | undefined;
		const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
			auth = (init!.headers as Record<string, string>).Authorization;
			const body = JSON.parse(init!.body as string) as { id: number };
			return jsonRpcResponse(body.id, { tools: [] });
		}) as typeof fetch;

		await listTools(
			{ ...SERVER, auth: { kind: "basic", username: "u", password: "p" } },
			fetchFn,
		);
		const expected = `Basic ${Buffer.from("u:p").toString("base64")}`;
		expect(auth).toBe(expected);
	});

	it("throws on JSON-RPC error", async () => {
		const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
			const body = JSON.parse(init!.body as string) as { id: number };
			return jsonRpcError(body.id, "method not found");
		}) as typeof fetch;
		await expect(listTools(SERVER, fetchFn)).rejects.toThrow(/method not found/);
	});

	it("throws on HTTP error", async () => {
		const fetchFn = (async () => new Response("boom", { status: 500 })) as typeof fetch;
		await expect(listTools(SERVER, fetchFn)).rejects.toThrow(/HTTP 500/);
	});
});

describe("callTool", () => {
	it("sends tools/call with args and returns the response", async () => {
		const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
			const body = JSON.parse(init!.body as string) as {
				id: number;
				method: string;
				params: { name: string; arguments: Record<string, unknown> };
			};
			expect(body.method).toBe("tools/call");
			expect(body.params.name).toBe("search");
			expect(body.params.arguments).toEqual({ q: "x" });
			return jsonRpcResponse(body.id, {
				content: [{ type: "text", text: "found 3 results" }],
			});
		}) as typeof fetch;

		const result = await callTool(SERVER, "search", { q: "x" }, fetchFn);
		expect(result.content?.[0]?.text).toBe("found 3 results");
	});
});

describe("extractText", () => {
	it("returns the first text content", () => {
		expect(extractText({ content: [{ type: "text", text: "hi" }] })).toBe("hi");
	});

	it("returns empty string when no text content", () => {
		expect(extractText({ content: [{ type: "image", data: "..." }] })).toBe("");
		expect(extractText({})).toBe("");
	});
});

describe("bridgedToolName", () => {
	it("uses the mcp:<server>:<tool> format", () => {
		expect(bridgedToolName("notion", "search")).toBe("mcp:notion:search");
	});
});
