/**
 * Agents client utilities — pure fetch wrappers over the plugin's
 * routes. Importable by other plugins (OpenRouter, Automations) that
 * need to look up agent configuration.
 *
 * The compile-context endpoint returns the agent + resolved skill
 * bodies + top-N memory entries, ready for system-prompt assembly.
 */

import type { Agent, CompiledAgentContext, MemoryEntry } from "./types.js";

const BASE = "/_emdash/api/plugins/agents";

interface ClientOptions {
	fetch?: typeof fetch;
	baseUrl?: string;
}

function urlFor(path: string, options: ClientOptions): string {
	return (options.baseUrl ?? "").replace(/\/$/, "") + `${BASE}${path}`;
}

export async function getAgent(id: string, options: ClientOptions = {}): Promise<Agent | null> {
	const fetchImpl = options.fetch ?? globalThis.fetch;
	const res = await fetchImpl(urlFor(`/agents.get?id=${encodeURIComponent(id)}`, options));
	if (!res.ok) return null;
	const json = (await res.json()) as { data?: { ok?: boolean; agent?: Agent } };
	return json.data?.agent ?? null;
}

export async function compileAgentContext(
	id: string,
	options: ClientOptions & { memoryLimit?: number } = {},
): Promise<CompiledAgentContext | null> {
	const fetchImpl = options.fetch ?? globalThis.fetch;
	const params = new URLSearchParams({ id });
	if (options.memoryLimit) params.set("memoryLimit", String(options.memoryLimit));
	const res = await fetchImpl(urlFor(`/agents.compile?${params.toString()}`, options));
	if (!res.ok) return null;
	const json = (await res.json()) as { data?: { ok?: boolean; context?: CompiledAgentContext } };
	return json.data?.context ?? null;
}

export async function putMemory(
	body: { agent_id: string; key: string; value: unknown; importance?: number; source?: string; tags?: string[] },
	options: ClientOptions = {},
): Promise<MemoryEntry | null> {
	const fetchImpl = options.fetch ?? globalThis.fetch;
	const res = await fetchImpl(urlFor("/memory.put", options), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!res.ok) return null;
	const json = (await res.json()) as { data?: { ok?: boolean; entry?: MemoryEntry } };
	return json.data?.entry ?? null;
}

/**
 * Build a system prompt from a compiled agent context. Composable
 * with other context (design system, brand voice) added by callers.
 */
export function assembleSystemPrompt(ctx: CompiledAgentContext): string {
	const sections: string[] = [];

	sections.push(`# Identity\n\n${ctx.agent.identity.trim()}`);

	if (ctx.agent.soul) {
		sections.push(`# Voice & values\n\n${ctx.agent.soul.trim()}`);
	}

	if (ctx.skills.length > 0) {
		sections.push(
			`# Skills\n\n${ctx.skills
				.map((s) => `## ${s.name}\n\n${s.body.trim()}`)
				.join("\n\n")}`,
		);
	}

	if (ctx.agent.tools_md) {
		sections.push(`# Environment\n\n${ctx.agent.tools_md.trim()}`);
	}

	if (ctx.memories.length > 0) {
		sections.push(
			`# Working memory\n\n${ctx.memories
				.map((m) => {
					const v = typeof m.value === "string" ? m.value : JSON.stringify(m.value);
					return `- **${m.key}** _(importance: ${m.importance.toFixed(2)})_: ${v}`;
				})
				.join("\n")}`,
		);
	}

	return sections.join("\n\n");
}
