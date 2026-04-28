import type { PluginContext } from "emdash";
import { afterEach, describe, expect, it } from "vitest";

import plugin from "../src/sandbox-entry.js";

const originalOpenRouterKey = process.env.OPENROUTER_API_KEY;

afterEach(() => {
	if (originalOpenRouterKey === undefined) {
		delete process.env.OPENROUTER_API_KEY;
	} else {
		process.env.OPENROUTER_API_KEY = originalOpenRouterKey;
	}
});

function jsonResponse(data: unknown, init?: ResponseInit): Response {
	return new Response(JSON.stringify(data), {
		status: 200,
		headers: { "Content-Type": "application/json" },
		...init,
	});
}

describe("agent-aware routing", () => {
	it("fails closed when an explicit agent cannot be compiled", async () => {
		process.env.OPENROUTER_API_KEY = "test-key";
		const calls: string[] = [];
		const ctx = {
			http: {
				fetch: async (url: string | URL | Request) => {
					const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
					calls.push(href);
					if (href.includes("/_emdash/api/plugins/agents/agents.compile")) {
						return jsonResponse({ data: { ok: false, error: "Not found" } });
					}
					if (href.includes("/_emdash/api/plugins/tools/tools.openaiSpec")) {
						return jsonResponse({
							data: { tools: [{ type: "function", function: { name: "all_tools" } }] },
						});
					}
					return jsonResponse({ choices: [{ message: { role: "assistant", content: "ok" } }] });
				},
			},
			kv: { get: async () => undefined },
			storage: { usage: { put: async () => {} } },
			log: { warn: () => {}, error: () => {} },
		} as unknown as PluginContext;

		const result = await plugin.routes.chat.handler(
			{
				input: {
					agent_id: "writer",
					useTools: true,
					messages: [{ role: "user", content: "Draft copy" }],
				},
				request: new Request("http://localhost/_emdash/api/plugins/llm-router/chat"),
			},
			ctx,
		);

		expect(result).toEqual({ ok: false, error: "Agent not found or inactive" });
		expect(
			calls.some((href) => href.includes("/tools.openaiSpec") && !href.includes("agent_id=")),
		).toBe(false);
	});
});
