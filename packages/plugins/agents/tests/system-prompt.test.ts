import { describe, expect, it } from "vitest";

import { assembleSystemPrompt } from "../src/client.js";
import type { Agent, CompiledAgentContext, MemoryEntry } from "../src/types.js";

const baseAgent: Agent = {
	id: "writer",
	name: "Writer",
	role: "Drafts copy",
	active: true,
	identity: "I am a careful writer.",
	model: { provider: "openrouter", model: "anthropic/claude-haiku-4-5" },
	skills: [],
	tools: [],
	created_at: "2026-01-01T00:00:00Z",
	updated_at: "2026-01-01T00:00:00Z",
};

const ctx = (overrides: Partial<CompiledAgentContext> = {}): CompiledAgentContext => ({
	agent: { ...baseAgent, ...overrides.agent },
	skills: overrides.skills ?? [],
	memories: overrides.memories ?? [],
});

describe("assembleSystemPrompt", () => {
	it("emits identity-only prompt when nothing else is set", () => {
		const out = assembleSystemPrompt(ctx());
		expect(out).toBe("# Identity\n\nI am a careful writer.");
	});

	it("appends Voice & values when soul is set", () => {
		const out = assembleSystemPrompt(ctx({ agent: { ...baseAgent, soul: "Be concise." } }));
		expect(out).toContain("# Voice & values\n\nBe concise.");
		expect(out.indexOf("# Identity")).toBeLessThan(out.indexOf("# Voice & values"));
	});

	it("renders skills with sub-headings in supplied order", () => {
		const out = assembleSystemPrompt(
			ctx({
				skills: [
					{ slug: "outline", name: "Outline first", body: "Always sketch an outline." },
					{ slug: "edit", name: "Edit ruthlessly", body: "Cut adjectives." },
				],
			}),
		);
		expect(out).toContain("# Skills");
		expect(out).toContain("## Outline first\n\nAlways sketch an outline.");
		expect(out).toContain("## Edit ruthlessly\n\nCut adjectives.");
		expect(out.indexOf("Outline first")).toBeLessThan(out.indexOf("Edit ruthlessly"));
	});

	it("omits the Skills section when none provided", () => {
		expect(assembleSystemPrompt(ctx())).not.toContain("# Skills");
	});

	it("includes Environment when tools_md is set", () => {
		const out = assembleSystemPrompt(
			ctx({ agent: { ...baseAgent, tools_md: "Use the `search` tool to find sources." } }),
		);
		expect(out).toContain("# Environment\n\nUse the `search` tool to find sources.");
	});

	it("renders memories with importance to 2 decimal places", () => {
		const mem: MemoryEntry = {
			id: "m1",
			agent_id: "writer",
			key: "tone",
			value: "warm but precise",
			importance: 0.7,
			last_accessed_at: "2026-01-01T00:00:00Z",
			created_at: "2026-01-01T00:00:00Z",
		};
		const out = assembleSystemPrompt(ctx({ memories: [mem] }));
		expect(out).toContain("# Working memory");
		expect(out).toContain("- **tone** _(importance: 0.70)_: warm but precise");
	});

	it("JSON-stringifies non-string memory values", () => {
		const mem: MemoryEntry = {
			id: "m1",
			agent_id: "writer",
			key: "preferred_models",
			value: { primary: "haiku", fallback: "sonnet" },
			importance: 0.5,
			last_accessed_at: "2026-01-01T00:00:00Z",
			created_at: "2026-01-01T00:00:00Z",
		};
		const out = assembleSystemPrompt(ctx({ memories: [mem] }));
		expect(out).toContain('{"primary":"haiku","fallback":"sonnet"}');
	});

	it("composes all sections in stable order: identity → soul → skills → environment → memory", () => {
		const out = assembleSystemPrompt(
			ctx({
				agent: { ...baseAgent, soul: "soul-text", tools_md: "tools-text" },
				skills: [{ slug: "s", name: "Skill", body: "skill-body" }],
				memories: [
					{
						id: "m1",
						agent_id: "writer",
						key: "k",
						value: "v",
						importance: 1.0,
						last_accessed_at: "2026-01-01T00:00:00Z",
						created_at: "2026-01-01T00:00:00Z",
					},
				],
			}),
		);
		const order = [
			"# Identity",
			"# Voice & values",
			"# Skills",
			"# Environment",
			"# Working memory",
		];
		const positions = order.map((h) => out.indexOf(h));
		expect(positions.every((p) => p >= 0)).toBe(true);
		expect(positions).toEqual(positions.toSorted((a, b) => a - b));
	});
});
