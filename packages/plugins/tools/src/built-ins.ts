/**
 * Built-in tools — the essentials an agent doing a Task needs.
 *
 * Wrap plugin-context APIs (ctx.content, ctx.http) and route to
 * other plugins' HTTP endpoints when the operation belongs there.
 *
 * Tool name convention: `<noun>_<verb>` (matches emdash MCP tool
 * naming, e.g. `content_list`, `content_get`).
 */

import type { PluginContext } from "emdash";

import { _registerBuiltin } from "./registry.js";
import type { Tool } from "./types.js";

const TRAILING_SLASH_RE = /\/$/;

/** @internal — exported for unit tests. */
export function asString(v: unknown, fallback = ""): string {
	return typeof v === "string" ? v : fallback;
}

/** @internal — exported for unit tests. */
export function asNumber(v: unknown, fallback?: number): number | undefined {
	if (typeof v === "number") return v;
	if (typeof v === "string" && !Number.isNaN(Number(v))) return Number(v);
	return fallback;
}

/** @internal — exported for unit tests. */
export function getSiteUrl(ctx: PluginContext): string {
	return ((ctx.site as { url?: string } | undefined)?.url ?? "http://localhost:4321").replace(
		TRAILING_SLASH_RE,
		"",
	);
}

const contentList: Tool = {
	name: "content_list",
	description:
		"List content items in a collection. Returns an array of items with their fields. Use limit + cursor for pagination. Status filter accepts 'draft', 'published', 'scheduled'.",
	parameters: {
		type: "object",
		properties: {
			collection: { type: "string", description: "Collection slug (e.g. 'posts')" },
			status: { type: "string", enum: ["draft", "published", "scheduled"] },
			limit: { type: "number" },
			cursor: { type: "string" },
		},
		required: ["collection"],
	},
	capabilities: ["read:content"],
	handler: async (args, ctx) => {
		if (!ctx.content) throw new Error("read:content capability missing");
		const status = asString(args.status);
		const result = await ctx.content.list(asString(args.collection), {
			where: status ? { status } : undefined,
			limit: asNumber(args.limit, 25),
			cursor: asString(args.cursor) || undefined,
		});
		return result;
	},
};

const contentGet: Tool = {
	name: "content_get",
	description:
		"Get a single content item by slug or id. Returns the full data object including fields.",
	parameters: {
		type: "object",
		properties: {
			collection: { type: "string" },
			id: { type: "string", description: "Slug or ULID" },
		},
		required: ["collection", "id"],
	},
	capabilities: ["read:content"],
	handler: async (args, ctx) => {
		if (!ctx.content) throw new Error("read:content capability missing");
		return await ctx.content.get(asString(args.collection), asString(args.id));
	},
};

const contentSearch: Tool = {
	name: "content_search",
	description:
		"Substring search over a collection's listable items. Loads the first 200 items and filters them in memory; for large catalogues, use the dedicated emdash search route via http_get instead.",
	parameters: {
		type: "object",
		properties: {
			collection: { type: "string" },
			q: { type: "string", description: "Substring query, case-insensitive" },
			limit: { type: "number" },
		},
		required: ["collection", "q"],
	},
	capabilities: ["read:content"],
	handler: async (args, ctx) => {
		if (!ctx.content) throw new Error("read:content capability missing");
		const q = asString(args.q).toLowerCase();
		const limit = asNumber(args.limit, 10) ?? 10;
		const result = await ctx.content.list(asString(args.collection), {
			limit: 200,
		});
		const items = (result.items ?? []) as unknown as Array<Record<string, unknown>>;
		const matches = items.filter((it) => JSON.stringify(it).toLowerCase().includes(q));
		return { items: matches.slice(0, limit), totalScanned: items.length };
	},
};

const taskCreate: Tool = {
	name: "task_create",
	description:
		"Create a new Task in the Tasks plugin. Use this to spin up sub-tasks or queue follow-up work for another agent.",
	parameters: {
		type: "object",
		properties: {
			goal: { type: "string" },
			description: { type: "string" },
			target_collection: { type: "string" },
			target_id: { type: "string" },
			assignee: { type: "string", description: "human:<id> or agent:<id>" },
			parent_id: { type: "string" },
			deadline: { type: "string", description: "ISO timestamp" },
		},
		required: ["goal"],
	},
	handler: async (args, ctx) => {
		if (!ctx.http) throw new Error("network:fetch capability missing");
		const url = `${getSiteUrl(ctx)}/_emdash/api/plugins/tasks/tasks.create`;
		const res = await ctx.http.fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(args),
		});
		if (!res.ok) throw new Error(`tasks.create returned ${res.status}`);
		return await res.json();
	},
};

const taskAdvance: Tool = {
	name: "task_advance",
	description:
		"Transition a task to a new status. The Tasks state machine validates the move; invalid transitions throw.",
	parameters: {
		type: "object",
		properties: {
			id: { type: "string" },
			to: {
				type: "string",
				enum: [
					"backlog",
					"in_progress",
					"pending_review",
					"approved",
					"rejected",
					"published",
					"cancelled",
				],
			},
			comment: { type: "string" },
		},
		required: ["id", "to"],
	},
	handler: async (args, ctx) => {
		if (!ctx.http) throw new Error("network:fetch capability missing");
		const url = `${getSiteUrl(ctx)}/_emdash/api/plugins/tasks/tasks.transition`;
		const res = await ctx.http.fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(args),
		});
		if (!res.ok) throw new Error(`tasks.transition returned ${res.status}`);
		return await res.json();
	},
};

const memorySearch: Tool = {
	name: "memory_search",
	description:
		"Search the calling agent's persistent memory. Ranked by importance + recency. Use to recall prior decisions, preferences, or context across tasks.",
	parameters: {
		type: "object",
		properties: {
			agent_id: { type: "string", description: "Agent slug whose memory to search" },
			query: { type: "string" },
			tags: { type: "array", items: { type: "string" } },
			importance_min: { type: "number" },
			limit: { type: "number" },
		},
		required: ["agent_id"],
	},
	handler: async (args, ctx) => {
		if (!ctx.http) throw new Error("network:fetch capability missing");
		const url = `${getSiteUrl(ctx)}/_emdash/api/plugins/agents/memory.search`;
		const res = await ctx.http.fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(args),
		});
		if (!res.ok) throw new Error(`memory.search returned ${res.status}`);
		return await res.json();
	},
};

const memoryPut: Tool = {
	name: "memory_put",
	description:
		"Store a fact in the agent's memory. Use this to record decisions, preferences, or summaries that future runs should remember. Importance 0..1.",
	parameters: {
		type: "object",
		properties: {
			agent_id: { type: "string" },
			key: { type: "string" },
			value: {},
			importance: { type: "number" },
			tags: { type: "array", items: { type: "string" } },
			source: { type: "string" },
		},
		required: ["agent_id", "key", "value"],
	},
	handler: async (args, ctx) => {
		if (!ctx.http) throw new Error("network:fetch capability missing");
		const url = `${getSiteUrl(ctx)}/_emdash/api/plugins/agents/memory.put`;
		const res = await ctx.http.fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(args),
		});
		if (!res.ok) throw new Error(`memory.put returned ${res.status}`);
		return await res.json();
	},
};

const BUILT_IN_TOOLS = [
	contentList,
	contentGet,
	contentSearch,
	taskCreate,
	taskAdvance,
	memorySearch,
	memoryPut,
];

export function registerBuiltInTools(): void {
	for (const tool of BUILT_IN_TOOLS) {
		_registerBuiltin(tool);
	}
}
