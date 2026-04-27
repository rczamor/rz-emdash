/**
 * Agents — runtime entrypoint.
 *
 * Routes:
 *   POST  agents.create               CreateAgentInput
 *   GET   agents.get?id=
 *   GET   agents.list
 *   POST  agents.update               UpdateAgentInput
 *   POST  agents.delete               { id }
 *   GET   agents.compile?id=&memoryLimit=    — assemble system-prompt context
 *
 *   POST  memory.put                  MemoryPutInput
 *   GET   memory.get?agent_id=&key=
 *   GET   memory.list?agent_id=&limit=&cursor=
 *   POST  memory.search               MemorySearchInput → ranked
 *   POST  memory.delete               { id } | { agent_id, key }
 *
 *   POST  admin                       Block Kit
 */

import { definePlugin } from "emdash";
import type { PluginContext, WhereValue } from "emdash";

import { renderRefreshedView, routeAdminInteraction } from "./admin.js";
import type {
	Agent,
	CompiledAgentContext,
	CreateAgentInput,
	MemoryEntry,
	MemoryPutInput,
	MemorySearchInput,
	UpdateAgentInput,
} from "./types.js";

interface RouteCtx {
	input: unknown;
	request: Request;
}

const NOW = () => new Date().toISOString();
const AGENT_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function scalarString(value: unknown, fallback = ""): string {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return fallback;
}

function getQueryParam(routeCtx: RouteCtx, key: string): string | undefined {
	return new URL(routeCtx.request.url).searchParams.get(key) ?? undefined;
}

function isValidAgentId(id: unknown): id is string {
	return typeof id === "string" && AGENT_ID_RE.test(id);
}

function parseList(raw: unknown): string[] {
	if (Array.isArray(raw))
		return raw
			.map(String)
			.map((s) => s.trim())
			.filter(Boolean);
	if (typeof raw === "string") {
		return raw
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
	}
	return [];
}

async function loadAgent(id: string, ctx: PluginContext): Promise<Agent | null> {
	const v = await ctx.storage.agents!.get(id);
	return (v as Agent | null) ?? null;
}

async function persistAgent(agent: Agent, ctx: PluginContext): Promise<void> {
	await ctx.storage.agents!.put(agent.id, agent);
}

// ── Agent CRUD ──────────────────────────────────────────────────────────────

async function createAgent(input: CreateAgentInput, ctx: PluginContext): Promise<Agent> {
	if (!isValidAgentId(input.id)) throw new Error("Invalid agent id");
	if (!input.name || !input.role || !input.identity) {
		throw new Error("name, role, and identity are required");
	}
	if (await ctx.storage.agents!.exists(input.id)) {
		throw new Error("Agent with that id already exists");
	}
	const agent: Agent = {
		id: input.id,
		name: input.name,
		role: input.role,
		active: input.active ?? true,
		identity: input.identity,
		soul: input.soul,
		tools_md: input.tools_md,
		model: input.model,
		skills: input.skills ?? [],
		tools: input.tools ?? [],
		skills_collection: input.skills_collection ?? "agent_skills",
		quotas: input.quotas,
		created_at: NOW(),
		updated_at: NOW(),
	};
	await persistAgent(agent, ctx);
	return agent;
}

async function updateAgent(input: UpdateAgentInput, ctx: PluginContext): Promise<Agent> {
	if (!isValidAgentId(input.id)) throw new Error("Invalid id");
	const agent = await loadAgent(input.id, ctx);
	if (!agent) throw new Error("Not found");
	if (input.name !== undefined) agent.name = input.name;
	if (input.role !== undefined) agent.role = input.role;
	if (input.active !== undefined) agent.active = input.active;
	if (input.identity !== undefined) agent.identity = input.identity;
	if (input.soul !== undefined) agent.soul = input.soul;
	if (input.tools_md !== undefined) agent.tools_md = input.tools_md;
	if (input.model) agent.model = { ...agent.model, ...input.model };
	if (input.skills !== undefined) agent.skills = input.skills;
	if (input.tools !== undefined) agent.tools = input.tools;
	if (input.skills_collection !== undefined) agent.skills_collection = input.skills_collection;
	if (input.quotas !== undefined) agent.quotas = input.quotas;
	agent.updated_at = NOW();
	await persistAgent(agent, ctx);
	return agent;
}

// ── Skill resolution ────────────────────────────────────────────────────────

async function resolveSkills(
	agent: Agent,
	ctx: PluginContext,
): Promise<Array<{ slug: string; name: string; body: string }>> {
	if (!ctx.content || agent.skills.length === 0) return [];
	const collection = agent.skills_collection ?? "agent_skills";
	const out: Array<{ slug: string; name: string; body: string }> = [];
	for (const slug of agent.skills) {
		try {
			const item = await ctx.content.get(collection, slug);
			if (!item) continue;
			const data = item as unknown as Record<string, unknown>;
			const name = scalarString(data.title ?? data.name, slug);
			const body = scalarString(data.body ?? data.content);
			out.push({ slug, name, body });
		} catch (err) {
			ctx.log.warn("Agents: skill resolution failed", {
				agentId: agent.id,
				slug,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
	return out;
}

// ── Memory ──────────────────────────────────────────────────────────────────

function newMemoryId(): string {
	return `m_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function putMemory(input: MemoryPutInput, ctx: PluginContext): Promise<MemoryEntry> {
	if (!isValidAgentId(input.agent_id)) throw new Error("Invalid agent_id");
	if (!input.key || typeof input.key !== "string") throw new Error("key required");

	// Same-key write replaces by composite (agent_id, key) — search storage
	// for an existing entry and reuse its id.
	const existing = await ctx.storage.memory!.query({
		where: { agent_id: input.agent_id, key: input.key },
		limit: 1,
	});
	const id = (existing.items[0]?.data as MemoryEntry | undefined)?.id ?? newMemoryId();

	const entry: MemoryEntry = {
		id,
		agent_id: input.agent_id,
		key: input.key,
		value: input.value,
		importance: input.importance ?? 0.5,
		source: input.source,
		tags: input.tags,
		last_accessed_at: NOW(),
		created_at: (existing.items[0]?.data as MemoryEntry | undefined)?.created_at ?? NOW(),
	};
	await ctx.storage.memory!.put(entry.id, entry);
	return entry;
}

async function searchMemory(input: MemorySearchInput, ctx: PluginContext): Promise<MemoryEntry[]> {
	if (!isValidAgentId(input.agent_id)) return [];
	const limit = Math.min(Math.max(input.limit ?? 10, 1), 200);
	const filter: Record<string, WhereValue> = { agent_id: input.agent_id };
	const result = await ctx.storage.memory!.query({
		where: filter,
		orderBy: { importance: "desc" },
		limit: 200,
	});

	let entries = result.items.map((i) => i.data as MemoryEntry);

	if (input.importance_min != null) {
		entries = entries.filter((e) => e.importance >= input.importance_min!);
	}
	if (input.tags && input.tags.length > 0) {
		entries = entries.filter((e) => e.tags?.some((t) => input.tags!.includes(t)));
	}
	if (input.query) {
		const q = input.query.toLowerCase();
		entries = entries.filter((e) => {
			const valueText = typeof e.value === "string" ? e.value : JSON.stringify(e.value);
			return e.key.toLowerCase().includes(q) || valueText.toLowerCase().includes(q);
		});
	}

	// Score = importance * 0.7 + recency * 0.3
	const now = Date.now();
	const scored = entries.map((e) => {
		const days = (now - new Date(e.last_accessed_at).getTime()) / (1000 * 60 * 60 * 24);
		const recency = 1 / (1 + days / 30);
		return { entry: e, score: e.importance * 0.7 + recency * 0.3 };
	});
	scored.sort((a, b) => b.score - a.score);
	return scored.slice(0, limit).map((s) => s.entry);
}

async function compileContext(
	agentId: string,
	memoryLimit: number,
	ctx: PluginContext,
): Promise<CompiledAgentContext | null> {
	const agent = await loadAgent(agentId, ctx);
	if (!agent) return null;
	if (!agent.active) return null;
	const skills = await resolveSkills(agent, ctx);
	const memories = await searchMemory({ agent_id: agentId, limit: memoryLimit }, ctx);
	return { agent, skills, memories };
}

// ── Plugin definition ───────────────────────────────────────────────────────

function deriveQuotasFromValues(values: Record<string, unknown>): Agent["quotas"] {
	const daily = Number(values.quota_daily ?? 0);
	const task = Number(values.quota_task ?? 0);
	if (daily === 0 && task === 0) return undefined;
	return {
		dailyTokens: daily > 0 ? daily : undefined,
		taskTokens: task > 0 ? task : undefined,
	};
}

export default definePlugin({
	hooks: {
		"plugin:install": {
			handler: async (_event: unknown, ctx: PluginContext) => {
				ctx.log.info("Agents plugin installed");
			},
		},
	},

	routes: {
		"agents.create": {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				try {
					const agent = await createAgent(routeCtx.input as CreateAgentInput, ctx);
					return { ok: true, agent };
				} catch (err) {
					return { ok: false, error: err instanceof Error ? err.message : String(err) };
				}
			},
		},

		"agents.get": {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const id = getQueryParam(routeCtx, "id");
				if (!isValidAgentId(id)) return { ok: false, error: "id required" };
				const agent = await loadAgent(id, ctx);
				if (!agent) return { ok: false, error: "Not found" };
				return { ok: true, agent };
			},
		},

		"agents.list": {
			handler: async (_routeCtx: RouteCtx, ctx: PluginContext) => {
				const result = await ctx.storage.agents!.query({
					orderBy: { created_at: "desc" },
					limit: 500,
				});
				return { agents: result.items.map((i) => i.data) };
			},
		},

		"agents.update": {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				try {
					const agent = await updateAgent(routeCtx.input as UpdateAgentInput, ctx);
					return { ok: true, agent };
				} catch (err) {
					return { ok: false, error: err instanceof Error ? err.message : String(err) };
				}
			},
		},

		"agents.delete": {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const body = routeCtx.input as { id?: unknown } | null;
				if (!body || !isValidAgentId(body.id)) return { ok: false, error: "id required" };
				const removed = await ctx.storage.agents!.delete(body.id);
				return { ok: true, removed };
			},
		},

		"agents.compile": {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const id = getQueryParam(routeCtx, "id");
				const memoryLimit = Math.min(
					parseInt(getQueryParam(routeCtx, "memoryLimit") ?? "10", 10) || 10,
					100,
				);
				if (!isValidAgentId(id)) return { ok: false, error: "id required" };
				const context = await compileContext(id, memoryLimit, ctx);
				if (!context) return { ok: false, error: "Not found" };
				return { ok: true, context };
			},
		},

		"memory.put": {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				try {
					const entry = await putMemory(routeCtx.input as MemoryPutInput, ctx);
					return { ok: true, entry };
				} catch (err) {
					return { ok: false, error: err instanceof Error ? err.message : String(err) };
				}
			},
		},

		"memory.get": {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const agent_id = getQueryParam(routeCtx, "agent_id");
				const key = getQueryParam(routeCtx, "key");
				if (!isValidAgentId(agent_id) || !key) {
					return { ok: false, error: "agent_id + key required" };
				}
				const result = await ctx.storage.memory!.query({
					where: { agent_id, key },
					limit: 1,
				});
				const entry = result.items[0]?.data as MemoryEntry | undefined;
				if (!entry) return { ok: false, error: "Not found" };
				return { ok: true, entry };
			},
		},

		"memory.list": {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const agent_id = getQueryParam(routeCtx, "agent_id");
				const limit = Math.min(
					Math.max(parseInt(getQueryParam(routeCtx, "limit") ?? "100", 10) || 100, 1),
					500,
				);
				const cursor = getQueryParam(routeCtx, "cursor");
				if (!isValidAgentId(agent_id)) return { ok: false, error: "agent_id required" };
				const result = await ctx.storage.memory!.query({
					where: { agent_id },
					orderBy: { last_accessed_at: "desc" },
					limit,
					cursor,
				});
				return {
					entries: result.items.map((i) => i.data),
					cursor: result.cursor,
					hasMore: result.hasMore,
				};
			},
		},

		"memory.search": {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const body = routeCtx.input as MemorySearchInput | null;
				if (!body || !isValidAgentId(body.agent_id)) {
					return { ok: false, error: "agent_id required" };
				}
				const entries = await searchMemory(body, ctx);
				return { ok: true, entries };
			},
		},

		"memory.delete": {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const body = routeCtx.input as { id?: string; agent_id?: string; key?: string } | null;
				if (!body) return { ok: false, error: "Body required" };
				if (body.id) {
					await ctx.storage.memory!.delete(body.id);
					return { ok: true };
				}
				if (body.agent_id && body.key) {
					const result = await ctx.storage.memory!.query({
						where: { agent_id: body.agent_id, key: body.key },
						limit: 1,
					});
					const entry = result.items[0]?.data as MemoryEntry | undefined;
					if (entry) await ctx.storage.memory!.delete(entry.id);
					return { ok: true };
				}
				return { ok: false, error: "id, or (agent_id + key) required" };
			},
		},

		admin: {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const interaction = routeCtx.input as Parameters<typeof routeAdminInteraction>[0];
				const decision = await routeAdminInteraction(interaction, ctx);

				if (decision.kind === "view") {
					return { blocks: decision.blocks };
				}

				let toastMessage = "";
				let toastType: "success" | "error" = "success";
				try {
					if (decision.effect.create) {
						const v = decision.effect.create.values;
						await createAgent(
							{
								id: scalarString(v.id).trim(),
								name: scalarString(v.name).trim(),
								role: scalarString(v.role).trim(),
								identity: scalarString(v.identity).trim(),
								soul: v.soul ? scalarString(v.soul) : undefined,
								model: {
									primary: scalarString(v.model_primary, "anthropic/claude-haiku-4-5"),
								},
								skills: parseList(v.skills),
								tools: parseList(v.tools),
							},
							ctx,
						);
						toastMessage = "Agent created";
					}
					if (decision.effect.save) {
						const v = decision.effect.save.values;
						await updateAgent(
							{
								id: decision.effect.save.id,
								name: v.name ? scalarString(v.name) : undefined,
								role: v.role ? scalarString(v.role) : undefined,
								identity: v.identity !== undefined ? scalarString(v.identity) : undefined,
								soul: v.soul !== undefined ? scalarString(v.soul) : undefined,
								model: v.model_primary ? { primary: scalarString(v.model_primary) } : undefined,
								skills: v.skills !== undefined ? parseList(v.skills) : undefined,
								tools: v.tools !== undefined ? parseList(v.tools) : undefined,
								quotas: deriveQuotasFromValues(v),
							},
							ctx,
						);
						toastMessage = "Agent saved";
					}
					if (decision.effect.toggle) {
						const a = await loadAgent(decision.effect.toggle.id, ctx);
						if (a) await updateAgent({ id: a.id, active: !a.active }, ctx);
						toastMessage = "Agent toggled";
					}
					if (decision.effect.delete) {
						await ctx.storage.agents!.delete(decision.effect.delete.id);
						toastMessage = "Agent deleted";
					}
				} catch (err) {
					toastMessage = err instanceof Error ? err.message : String(err);
					toastType = "error";
				}

				const blocks = await renderRefreshedView(decision.refresh.agentId, ctx);
				return { blocks, toast: { message: toastMessage, type: toastType } };
			},
		},
	},
});
