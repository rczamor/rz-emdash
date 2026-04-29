import type { PluginContext } from "emdash";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { _resetTools, getTool } from "../src/registry.js";
import { registerBuiltInTools } from "../src/built-ins.js";

beforeEach(() => {
	_resetTools();
	registerBuiltInTools();
});

function fakeCtx(httpFetch: typeof fetch): PluginContext {
	return {
		plugin: { id: "test", version: "0.0.1" },
		storage: {} as PluginContext["storage"],
		kv: { get: async () => null, set: async () => {}, delete: async () => false, list: async () => [] },
		log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as PluginContext["log"],
		site: { url: "http://localhost:4321" } as unknown as PluginContext["site"],
		url: (p: string) => `http://localhost:4321${p}`,
		http: { fetch: httpFetch },
	} as PluginContext;
}

describe("skill_list", () => {
	it("returns the agent's skill index from agents.compile", async () => {
		const fetchMock = vi.fn(
			async (input: string | URL | Request) =>
				new Response(
					JSON.stringify({
						data: {
							ok: true,
							context: {
								agent: {},
								memories: [],
								skills: [
									{ slug: "tone", name: "Tone of voice", summary: "Warm but precise" },
									{ slug: "outline", name: "Outline first", summary: "Sketch before drafting" },
								],
							},
						},
					}),
					{ status: 200 },
				),
		);
		const tool = getTool("skill_list")!;
		const result = (await tool.handler({ agent_id: "writer" }, fakeCtx(fetchMock as unknown as typeof fetch))) as {
			skills: Array<{ slug: string; summary: string }>;
		};
		expect(result.skills).toHaveLength(2);
		expect(result.skills[0]?.slug).toBe("tone");
		expect(result.skills[0]?.summary).toBe("Warm but precise");
		expect(fetchMock).toHaveBeenCalledWith(
			expect.stringContaining("agents.compile?id=writer"),
		);
	});

	it("derives summary from body when summary missing (legacy bulk-loaded mode)", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						data: {
							ok: true,
							context: {
								agent: {},
								memories: [],
								skills: [{ slug: "x", name: "X", body: "Long body content" }],
							},
						},
					}),
					{ status: 200 },
				),
		);
		const tool = getTool("skill_list")!;
		const result = (await tool.handler({ agent_id: "w" }, fakeCtx(fetchMock as unknown as typeof fetch))) as {
			skills: Array<{ summary: string }>;
		};
		expect(result.skills[0]?.summary).toBe("Long body content");
	});
});

describe("skill_load", () => {
	it("returns the skill body via agents.skill.get", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						data: {
							ok: true,
							skill: {
								slug: "tone",
								name: "Tone of voice",
								body: "## Tone\n\nWarm but precise. Avoid jargon.",
							},
						},
					}),
					{ status: 200 },
				),
		);
		const tool = getTool("skill_load")!;
		const result = (await tool.handler(
			{ agent_id: "writer", slug: "tone" },
			fakeCtx(fetchMock as unknown as typeof fetch),
		)) as { slug: string; body: string };
		expect(result.slug).toBe("tone");
		expect(result.body).toContain("Warm but precise");
	});

	it("returns ok:false when the skill is not in the agent's allowlist", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({ data: { ok: false, error: "Skill 'hr' not in agent's allowlist" } }),
					{ status: 200 },
				),
		);
		const tool = getTool("skill_load")!;
		const result = (await tool.handler(
			{ agent_id: "writer", slug: "hr" },
			fakeCtx(fetchMock as unknown as typeof fetch),
		)) as { ok: boolean; error: string };
		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/allowlist/);
	});
});
