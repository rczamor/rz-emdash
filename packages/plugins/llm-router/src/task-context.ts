/**
 * Quota check + agent compile + tool spec helpers — shared across
 * router routes and automation actions.
 */

import type { PluginContext } from "emdash";

import type { ChatCompletionInput } from "./types.js";

interface QuotaCheckResult {
	ok: boolean;
	reason?: string;
	dailyTokensUsed?: number;
	dailyTokensLimit?: number;
	taskTokensUsed?: number;
	taskTokensLimit?: number;
}

function siteUrl(ctx: PluginContext): string {
	return (((ctx.site as { url?: string } | undefined)?.url ?? "http://localhost:4321") as string).replace(/\/$/, "");
}

export async function checkQuota(
	body: { actor: string; taskId?: string; estimatedTokensIn?: number; estimatedTokensOut?: number },
	ctx: PluginContext,
): Promise<QuotaCheckResult> {
	if (!ctx.http) return { ok: true };
	try {
		const res = await ctx.http.fetch(`${siteUrl(ctx)}/_emdash/api/plugins/tasks/quota.check`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		if (!res.ok) return { ok: true };
		const json = (await res.json()) as { data?: QuotaCheckResult };
		return json.data ?? { ok: true };
	} catch {
		return { ok: true };
	}
}

export async function compileAgentSystemPrompt(
	agentId: string,
	memoryLimit: number,
	ctx: PluginContext,
): Promise<{ systemPrompt: string; agentTools: string[]; agentModel?: string } | null> {
	if (!ctx.http) return null;
	try {
		const res = await ctx.http.fetch(
			`${siteUrl(ctx)}/_emdash/api/plugins/agents/agents.compile?id=${encodeURIComponent(agentId)}&memoryLimit=${memoryLimit}`,
		);
		if (!res.ok) return null;
		const json = (await res.json()) as {
			data?: {
				ok?: boolean;
				context?: {
					agent: {
						identity: string;
						soul?: string;
						tools_md?: string;
						tools: string[];
						model: { primary: string };
					};
					skills: Array<{ name: string; body: string }>;
					memories: Array<{ key: string; value: unknown; importance: number }>;
				};
			};
		};
		const context = json.data?.context;
		if (!context) return null;

		const sections: string[] = [];
		sections.push(`# Identity\n\n${context.agent.identity.trim()}`);
		if (context.agent.soul) sections.push(`# Voice & values\n\n${context.agent.soul.trim()}`);
		if (context.skills.length > 0) {
			sections.push(
				`# Skills\n\n${context.skills.map((s) => `## ${s.name}\n\n${s.body.trim()}`).join("\n\n")}`,
			);
		}
		if (context.agent.tools_md) sections.push(`# Environment\n\n${context.agent.tools_md.trim()}`);
		if (context.memories.length > 0) {
			sections.push(
				`# Working memory\n\n${context.memories
					.map((m) => {
						const v = typeof m.value === "string" ? m.value : JSON.stringify(m.value);
						return `- **${m.key}** (importance ${m.importance.toFixed(2)}): ${v}`;
					})
					.join("\n")}`,
			);
		}

		return {
			systemPrompt: sections.join("\n\n"),
			agentTools: context.agent.tools,
			agentModel: context.agent.model.primary,
		};
	} catch {
		return null;
	}
}

export async function fetchAgentToolsForOpenAI(
	agentId: string | undefined,
	ctx: PluginContext,
): Promise<ChatCompletionInput["tools"]> {
	if (!ctx.http) return undefined;
	const url = agentId
		? `${siteUrl(ctx)}/_emdash/api/plugins/tools/tools.openaiSpec?agent_id=${encodeURIComponent(agentId)}`
		: `${siteUrl(ctx)}/_emdash/api/plugins/tools/tools.openaiSpec`;
	try {
		const res = await ctx.http.fetch(url);
		if (!res.ok) return undefined;
		const json = (await res.json()) as { data?: { tools?: ChatCompletionInput["tools"] } };
		const tools = json.data?.tools;
		return tools && tools.length > 0 ? tools : undefined;
	} catch {
		return undefined;
	}
}
