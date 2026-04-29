import { beforeEach, describe, expect, it, vi } from "vitest";

import { _resetTools, getTool, listToolNames } from "@emdash-cms/plugin-tools/registry";

import { bridgeServerTools, unbridgeServer } from "../src/tool-bridge.js";
import type { McpServerConfig } from "../src/types.js";

const SERVER: McpServerConfig = {
	id: "notion",
	name: "Notion",
	url: "https://mcp.example/notion",
	created_at: "2026-04-29T00:00:00Z",
	updated_at: "2026-04-29T00:00:00Z",
};

beforeEach(() => {
	_resetTools();
});

describe("bridgeServerTools", () => {
	it("registers each MCP tool as mcp:<server>:<tool>", () => {
		const registered = bridgeServerTools(SERVER, [
			{ name: "search", description: "search docs" },
			{ name: "get-page", description: "fetch a page" },
		]);
		expect(registered.sort()).toEqual(["mcp:notion:get-page", "mcp:notion:search"]);
		expect(listToolNames()).toContain("mcp:notion:search");
	});

	it("filters by allow_tools when set", () => {
		const registered = bridgeServerTools(
			{ ...SERVER, allow_tools: ["search"] },
			[
				{ name: "search" },
				{ name: "get-page" },
				{ name: "delete" },
			],
		);
		expect(registered).toEqual(["mcp:notion:search"]);
		expect(listToolNames()).not.toContain("mcp:notion:delete");
	});

	it("declares network:fetch capability on bridged tools", () => {
		bridgeServerTools(SERVER, [{ name: "x" }]);
		const tool = getTool("mcp:notion:x");
		expect(tool?.capabilities).toContain("network:fetch");
	});
});

describe("bridged tool handler", () => {
	it("calls the MCP server when invoked", async () => {
		// We need to control globalThis.fetch since the bridge uses it.
		const fetchSpy = vi.fn(async () =>
			new Response(
				JSON.stringify({
					jsonrpc: "2.0",
					id: 99,
					result: { content: [{ type: "text", text: "ok" }] },
				}),
				{ status: 200 },
			),
		);
		const originalFetch = globalThis.fetch;
		globalThis.fetch = fetchSpy as unknown as typeof fetch;
		try {
			bridgeServerTools(SERVER, [{ name: "search" }]);
			const tool = getTool("mcp:notion:search")!;
			const result = (await tool.handler({ q: "test" }, {} as never)) as {
				ok: boolean;
				content: Array<{ text?: string }>;
			};
			expect(result.ok).toBe(true);
			expect(result.content[0]?.text).toBe("ok");
			expect(fetchSpy).toHaveBeenCalled();
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("returns ok:false when the MCP response has isError", async () => {
		const fetchSpy = vi.fn(async () =>
			new Response(
				JSON.stringify({
					jsonrpc: "2.0",
					id: 100,
					result: {
						isError: true,
						content: [{ type: "text", text: "permission denied" }],
					},
				}),
				{ status: 200 },
			),
		);
		const original = globalThis.fetch;
		globalThis.fetch = fetchSpy as unknown as typeof fetch;
		try {
			bridgeServerTools(SERVER, [{ name: "delete" }]);
			const tool = getTool("mcp:notion:delete")!;
			const result = (await tool.handler({}, {} as never)) as { ok: boolean; error: string };
			expect(result.ok).toBe(false);
			expect(result.error).toBe("permission denied");
		} finally {
			globalThis.fetch = original;
		}
	});
});

describe("unbridgeServer", () => {
	it("removes all previously bridged tools", () => {
		const names = bridgeServerTools(SERVER, [{ name: "a" }, { name: "b" }]);
		expect(listToolNames()).toContain("mcp:notion:a");
		unbridgeServer(names);
		expect(listToolNames()).not.toContain("mcp:notion:a");
		expect(listToolNames()).not.toContain("mcp:notion:b");
	});
});
