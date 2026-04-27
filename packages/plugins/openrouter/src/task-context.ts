/**
 * Helpers for the Tasks + Agents integration.
 *
 * checkQuota — hits POST tasks.quota.check before an LLM call so a
 * quota-exceeded run is rejected without billing.
 *
 * compileAgentSystemPrompt — fetches the Agents plugin's compiled
 * context (identity, soul, skills, top-N memories) and returns a
 * single system-prompt string.
 *
 * fetchAgentToolsForOpenAI — pulls the tools the agent's allowlist
 * exposes from the Tools plugin in OpenAI-compatible format.
 */

import type { PluginContext } from "emdash";

import type { ChatCompletionInput } from "./client.js";

const TRAILING_SLASH_RE = /\/$/;

interface QuotaCheckResult {
	ok: boolean;
	reason?: string;
	dailyTokensUsed?: number;
	dailyTokensLimit?: number;
	taskTokensUsed?: number;
	taskTokensLimit?: number;
}

function siteUrl(ctx: PluginContext): string {
	return ((ctx.site as { url?: string } | undefined)?.url ?? "http://localhost:4321").replace(
		TRAILING_SLASH_RE,
		"",
	);
}

export async function checkQuota(
	body: { actor: string; taskId?: string; estimatedTokensIn?: number; estimatedTokensOut?: number },
	ctx: PluginContext,
): Promise<QuotaCheckResult> {
	if (!ctx.http) return { ok: false, reason: "Unable to verify quota" };
	try {
		const res = await ctx.http.fetch(`${siteUrl(ctx)}/_emdash/api/plugins/tasks/quota.check`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		// 404 → tasks plugin not installed; no quota enforcement is configured.
		// Distinct from "tasks plugin installed but failing" (5xx) or
		// "tasks plugin returned a structured deny" (200 with ok:false).
		if (res.status === 404) return { ok: true };
		if (!res.ok) return { ok: false, reason: `Quota check failed with ${res.status}` };
		const json = (await res.json()) as { data?: QuotaCheckResult };
		return json.data ?? { ok: false, reason: "Quota check returned no data" };
	} catch (err) {
		return {
			ok: false,
			reason: err instanceof Error ? err.message : "Quota check failed",
		};
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
