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

// =====================================================================
// Content write tools (M2)
// =====================================================================

/**
 * Tools that mutate content. All require `write:content` capability.
 *
 * Approval gates: `content_publish` always requires plan-mode approval
 * (M3); `content_update` requires it when the target item is already
 * published; `content_delete` always requires it. Approval is
 * communicated by returning `{ ok: false, paused_for_human: {...} }`
 * which the runs harness sees and transitions the run to
 * `awaiting_approval`. M3 wires the approval token check.
 */

/**
 * Approval-gate marker: callers (the runs harness) set `_force_execute: true`
 * after a human approves the gated tool. M2 gated tools check this and skip
 * the pause, executing for real. Anyone else calling the tool directly with
 * this flag bypasses approval — by design; the flag is internal to the
 * harness's approve/deny path. tools.invoke surfaces this only when the
 * caller has already presented an approval token validated against the run.
 */
function isForcedExecute(args: Record<string, unknown>): boolean {
	return args._force_execute === true;
}

const PAUSED_FOR_PUBLISH = (collection: string, id: string, data: Record<string, unknown>) => ({
	ok: false as const,
	paused_for_human: {
		kind: "tool-approval",
		tool: "content_publish",
		args: { collection, id, data },
		reason: "Publishing to live content always requires human approval.",
	},
});

const contentCreate: Tool = {
	name: "content_create",
	description:
		"Create a new content item in a collection. Status defaults to 'draft'. Returns the created item's id and slug. Use content_publish (which requires approval) to take a draft live.",
	parameters: {
		type: "object",
		properties: {
			collection: { type: "string", description: "Collection slug" },
			data: {
				type: "object",
				description: "Field values keyed by field name. May include 'slug' and 'seo'.",
				additionalProperties: true,
			},
		},
		required: ["collection", "data"],
	},
	capabilities: ["write:content"],
	handler: async (args, ctx) => {
		const content = ctx.content as
			| { create?: (c: string, d: Record<string, unknown>) => Promise<unknown> }
			| undefined;
		if (!content?.create) throw new Error("write:content capability missing");
		const collection = asString(args.collection);
		const data = (args.data ?? {}) as Record<string, unknown>;
		// Force draft status on create — agents must explicitly publish via
		// content_publish (which is always gated by approval).
		const result = await content.create(collection, { ...data, status: "draft" });
		return result;
	},
};

const contentUpdate: Tool = {
	name: "content_update",
	description:
		"Update an existing content item. If the target is already published, this requires plan-mode approval before executing. Drafts can be updated freely.",
	parameters: {
		type: "object",
		properties: {
			collection: { type: "string" },
			id: { type: "string", description: "Slug or ULID" },
			data: { type: "object", additionalProperties: true },
		},
		required: ["collection", "id", "data"],
	},
	capabilities: ["write:content"],
	handler: async (args, ctx) => {
		const content = ctx.content as
			| {
					get?: (c: string, id: string) => Promise<{ status?: string } | null>;
					update?: (
						c: string,
						id: string,
						d: Record<string, unknown>,
					) => Promise<unknown>;
			  }
			| undefined;
		if (!content?.update || !content?.get) throw new Error("write:content capability missing");
		const collection = asString(args.collection);
		const id = asString(args.id);
		const data = (args.data ?? {}) as Record<string, unknown>;

		// Approval gate: published items require approval; drafts pass.
		// `_force_execute` is set by the runs harness on resume after a
		// human approval — bypass the gate when present.
		const existing = await content.get(collection, id);
		if (existing?.status === "published" && !isForcedExecute(args)) {
			return {
				ok: false,
				paused_for_human: {
					kind: "tool-approval",
					tool: "content_update",
					args: { collection, id, data },
					reason: "Editing live content requires human approval.",
				},
			};
		}
		// Strip the harness flag before forwarding to the data layer.
		const { _force_execute: _omitted, ...cleanData } = data;
		void _omitted;
		return await content.update(collection, id, cleanData);
	},
};

const contentPublish: Tool = {
	name: "content_publish",
	description:
		"Transition a content item to status 'published'. Always requires plan-mode approval. M9 (validation gates) inserts brand/moderation/SEO checks before approval is requested.",
	parameters: {
		type: "object",
		properties: {
			collection: { type: "string" },
			id: { type: "string" },
			data: {
				type: "object",
				description: "Optional final field updates applied along with the status change.",
				additionalProperties: true,
			},
		},
		required: ["collection", "id"],
	},
	capabilities: ["write:content"],
	handler: async (args, ctx) => {
		const collection = asString(args.collection);
		const id = asString(args.id);
		const data = (args.data ?? {}) as Record<string, unknown>;
		// Always pause for approval. M3's runs.resume verifies the
		// approval token and re-invokes the tool with _force_execute=true
		// to bypass this check; the gate is enforced exactly once.
		if (!isForcedExecute(args)) {
			return PAUSED_FOR_PUBLISH(collection, id, { ...data, status: "published" });
		}
		const content = ctx.content as
			| { update?: (c: string, id: string, d: Record<string, unknown>) => Promise<unknown> }
			| undefined;
		if (!content?.update) throw new Error("write:content capability missing");
		return await content.update(collection, id, { ...data, status: "published" });
	},
};

const contentSchedule: Tool = {
	name: "content_schedule",
	description:
		"Schedule a content item to be published at a future timestamp. Sets `scheduled_at`; the scheduler plugin handles the actual flip on its tick.",
	parameters: {
		type: "object",
		properties: {
			collection: { type: "string" },
			id: { type: "string" },
			scheduled_at: { type: "string", description: "ISO timestamp" },
		},
		required: ["collection", "id", "scheduled_at"],
	},
	capabilities: ["write:content"],
	handler: async (args, ctx) => {
		const content = ctx.content as
			| {
					update?: (
						c: string,
						id: string,
						d: Record<string, unknown>,
					) => Promise<unknown>;
			  }
			| undefined;
		if (!content?.update) throw new Error("write:content capability missing");
		return await content.update(asString(args.collection), asString(args.id), {
			scheduled_at: asString(args.scheduled_at),
		});
	},
};

const contentDelete: Tool = {
	name: "content_delete",
	description:
		"Delete a content item. Always requires plan-mode approval, even for drafts.",
	parameters: {
		type: "object",
		properties: {
			collection: { type: "string" },
			id: { type: "string" },
		},
		required: ["collection", "id"],
	},
	capabilities: ["write:content"],
	handler: async (args, ctx) => {
		const collection = asString(args.collection);
		const id = asString(args.id);
		if (!isForcedExecute(args)) {
			return {
				ok: false,
				paused_for_human: {
					kind: "tool-approval",
					tool: "content_delete",
					args: { collection, id },
					reason: "Deleting content requires human approval, even for drafts.",
				},
			};
		}
		const content = ctx.content as
			| { delete?: (c: string, id: string) => Promise<boolean> }
			| undefined;
		if (!content?.delete) throw new Error("write:content capability missing");
		return await content.delete(collection, id);
	},
};

// =====================================================================
// Media tools (M2)
// =====================================================================

const mediaUpload: Tool = {
	name: "media_upload",
	description:
		"Upload a media item by fetching a URL (host allowlist + SSRF enforced) or by inlined base64 bytes. Returns the created media id and public URL.",
	parameters: {
		type: "object",
		properties: {
			filename: { type: "string" },
			contentType: { type: "string", description: "MIME type, e.g. 'image/png'" },
			source_url: {
				type: "string",
				description: "URL to fetch the bytes from. Must be allowlisted in the agent's plugin config.",
			},
			bytes_base64: {
				type: "string",
				description: "Alternative to source_url. Raw bytes encoded as base64.",
			},
		},
		required: ["filename", "contentType"],
	},
	capabilities: ["write:media", "network:fetch"],
	handler: async (args, ctx) => {
		const media = ctx.media as
			| {
					upload?: (
						filename: string,
						contentType: string,
						bytes: ArrayBuffer,
					) => Promise<{ mediaId: string; url: string }>;
			  }
			| undefined;
		if (!media?.upload) throw new Error("write:media capability missing");
		const filename = asString(args.filename);
		const contentType = asString(args.contentType);
		let bytes: ArrayBuffer;
		if (args.source_url) {
			if (!ctx.http) throw new Error("network:fetch capability missing");
			const res = await ctx.http.fetch(asString(args.source_url));
			if (!res.ok) throw new Error(`Source URL returned ${res.status}`);
			bytes = await res.arrayBuffer();
		} else if (args.bytes_base64) {
			const b64 = asString(args.bytes_base64);
			const bin = typeof Buffer !== "undefined" ? Buffer.from(b64, "base64") : null;
			if (!bin) throw new Error("base64 decode requires Node Buffer");
			bytes = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength) as ArrayBuffer;
		} else {
			throw new Error("Either source_url or bytes_base64 is required");
		}
		return await media.upload(filename, contentType, bytes);
	},
};

const mediaDelete: Tool = {
	name: "media_delete",
	description: "Delete a media item. Always requires plan-mode approval.",
	parameters: {
		type: "object",
		properties: { id: { type: "string" } },
		required: ["id"],
	},
	capabilities: ["write:media"],
	handler: async (args, ctx) => {
		const id = asString(args.id);
		if (!isForcedExecute(args)) {
			return {
				ok: false,
				paused_for_human: {
					kind: "tool-approval",
					tool: "media_delete",
					args: { id },
					reason: "Deleting media requires human approval.",
				},
			};
		}
		const media = ctx.media as
			| { delete?: (id: string) => Promise<boolean> }
			| undefined;
		if (!media?.delete) throw new Error("write:media capability missing");
		return await media.delete(id);
	},
};

// =====================================================================
// Web tools (M2)
// =====================================================================

const webFetch: Tool = {
	name: "web_fetch",
	description:
		"Fetch a URL and return its text body. Subject to the agent's plugin host allowlist + SSRF protection. Use sparingly — long pages flood context.",
	parameters: {
		type: "object",
		properties: {
			url: { type: "string" },
			max_chars: {
				type: "number",
				description: "Truncate the body to this many characters. Default 10000.",
			},
		},
		required: ["url"],
	},
	capabilities: ["network:fetch"],
	handler: async (args, ctx) => {
		if (!ctx.http) throw new Error("network:fetch capability missing");
		const url = asString(args.url);
		const maxChars = asNumber(args.max_chars, 10000) ?? 10000;
		const res = await ctx.http.fetch(url);
		if (!res.ok) {
			return { ok: false, status: res.status, error: `HTTP ${res.status}` };
		}
		const text = await res.text();
		return {
			ok: true,
			url,
			status: res.status,
			content_type: res.headers.get("content-type") ?? "",
			body: text.slice(0, maxChars),
			truncated: text.length > maxChars,
			length: text.length,
		};
	},
};

// =====================================================================
// Pure scoring tools — no capabilities, no I/O (M2)
// =====================================================================

/**
 * Strip HTML tags and extract plain text. Conservative — keeps the
 * inner content, drops all attributes and tag wrappers.
 */
function htmlToText(html: string): string {
	return html
		.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Count syllables in a word. Heuristic — used for Flesch-Kincaid.
 * Not perfect, but good enough for relative scoring.
 */
function countSyllables(word: string): number {
	const w = word.toLowerCase().replace(/[^a-z]/g, "");
	if (w.length <= 3) return 1;
	const matches = w
		.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "")
		.replace(/^y/, "")
		.match(/[aeiouy]{1,2}/g);
	return Math.max(1, matches?.length ?? 1);
}

const readabilityScore: Tool = {
	name: "readability_score",
	description:
		"Compute Flesch-Kincaid readability score and reading time for a piece of content. Higher Flesch = easier to read; 60-70 is standard for blog content.",
	parameters: {
		type: "object",
		properties: {
			text: {
				type: "string",
				description: "Plain text or HTML. HTML tags are stripped before scoring.",
			},
		},
		required: ["text"],
	},
	handler: async (args) => {
		const raw = asString(args.text);
		const text = raw.includes("<") ? htmlToText(raw) : raw;
		const sentences = (text.match(/[^.!?]+[.!?]+/g) ?? [text]).filter((s) => s.trim());
		const words = text.split(/\s+/).filter(Boolean);
		const syllables = words.reduce((sum, w) => sum + countSyllables(w), 0);
		const numWords = Math.max(words.length, 1);
		const numSentences = Math.max(sentences.length, 1);
		// Flesch reading ease: 206.835 - 1.015 (W/S) - 84.6 (Sy/W)
		const flesch = 206.835 - 1.015 * (numWords / numSentences) - 84.6 * (syllables / numWords);
		// Reading time at 220 wpm.
		const readingMinutes = numWords / 220;
		return {
			words: numWords,
			sentences: numSentences,
			syllables,
			flesch_reading_ease: Math.max(0, Math.round(flesch * 10) / 10),
			reading_minutes: Math.round(readingMinutes * 10) / 10,
		};
	},
};

const seoScore: Tool = {
	name: "seo_score",
	description:
		"Score a content item against basic SEO heuristics. Returns a 0-100 score plus a list of findings (warn/fail).",
	parameters: {
		type: "object",
		properties: {
			title: { type: "string" },
			description: { type: "string", description: "Meta description" },
			body: { type: "string", description: "Full body — plain text or HTML" },
			slug: { type: "string" },
		},
		required: ["title", "body"],
	},
	handler: async (args) => {
		const title = asString(args.title);
		const description = asString(args.description);
		const slug = asString(args.slug);
		const body = asString(args.body);
		const text = body.includes("<") ? htmlToText(body) : body;
		const findings: Array<{ severity: "pass" | "warn" | "fail"; message: string }> = [];
		let score = 100;

		if (!title) {
			findings.push({ severity: "fail", message: "Missing title" });
			score -= 30;
		} else if (title.length < 30 || title.length > 70) {
			findings.push({
				severity: "warn",
				message: `Title length ${title.length} chars (recommended 30-70)`,
			});
			score -= 5;
		}

		if (!description) {
			findings.push({ severity: "warn", message: "Missing meta description" });
			score -= 10;
		} else if (description.length < 70 || description.length > 160) {
			findings.push({
				severity: "warn",
				message: `Description length ${description.length} chars (recommended 70-160)`,
			});
			score -= 3;
		}

		if (!slug) {
			findings.push({ severity: "warn", message: "Missing slug" });
			score -= 5;
		} else if (slug.length > 75) {
			findings.push({ severity: "warn", message: "Slug exceeds 75 chars" });
			score -= 3;
		}

		const wordCount = text.split(/\s+/).filter(Boolean).length;
		if (wordCount < 200) {
			findings.push({ severity: "warn", message: `Body is short (${wordCount} words)` });
			score -= 10;
		}

		// h1 check (only meaningful for HTML input)
		if (body.includes("<")) {
			const h1Count = (body.match(/<h1\b/gi) ?? []).length;
			if (h1Count === 0) findings.push({ severity: "warn", message: "No <h1> in body" });
			if (h1Count > 1) findings.push({ severity: "warn", message: `Multiple <h1> (${h1Count})` });
		}

		return { score: Math.max(0, score), findings };
	},
};

// =====================================================================
// Skills tools (M8 — progressive disclosure)
// =====================================================================

const skillList: Tool = {
	name: "skill_list",
	description:
		"Return the index of skills available to the calling agent (slug, name, summary). Use this to decide which skills to load via skill_load. Skills are loaded on demand to keep the system prompt small.",
	parameters: {
		type: "object",
		properties: {
			agent_id: { type: "string", description: "Agent whose skills to list" },
		},
		required: ["agent_id"],
	},
	capabilities: ["network:fetch"],
	handler: async (args, ctx) => {
		if (!ctx.http) throw new Error("network:fetch capability missing");
		const baseUrl = (
			(ctx.site as { url?: string } | undefined)?.url ?? "http://localhost:4321"
		).replace(/\/$/, "");
		const res = await ctx.http.fetch(
			`${baseUrl}/_emdash/api/plugins/agents/agents.compile?id=${encodeURIComponent(asString(args.agent_id))}`,
		);
		if (!res.ok) throw new Error(`agents.compile returned ${res.status}`);
		const json = (await res.json()) as {
			data?: {
				ok?: boolean;
				context?: { skills?: Array<{ slug: string; name: string; summary?: string; body?: string }> };
			};
		};
		const skills = json.data?.context?.skills ?? [];
		return {
			skills: skills.map((s) => ({
				slug: s.slug,
				name: s.name,
				summary: s.summary ?? (s.body ? s.body.slice(0, 280) : ""),
			})),
		};
	},
};

const skillLoad: Tool = {
	name: "skill_load",
	description:
		"Fetch the full body of a specific skill by slug. The agent's allowlist is enforced — only skills declared in the agent's `skills` array can be loaded. Use this after skill_list to decide which skill is relevant.",
	parameters: {
		type: "object",
		properties: {
			agent_id: { type: "string" },
			slug: { type: "string", description: "Skill slug (e.g. 'editorial-voice')" },
		},
		required: ["agent_id", "slug"],
	},
	capabilities: ["network:fetch"],
	handler: async (args, ctx) => {
		if (!ctx.http) throw new Error("network:fetch capability missing");
		const baseUrl = (
			(ctx.site as { url?: string } | undefined)?.url ?? "http://localhost:4321"
		).replace(/\/$/, "");
		const res = await ctx.http.fetch(
			`${baseUrl}/_emdash/api/plugins/agents/agents.skill.get?agent_id=${encodeURIComponent(asString(args.agent_id))}&slug=${encodeURIComponent(asString(args.slug))}`,
		);
		if (!res.ok) throw new Error(`agents.skill.get returned ${res.status}`);
		const json = (await res.json()) as {
			data?: { ok?: boolean; skill?: { slug: string; name: string; body: string }; error?: string };
		};
		const data = json.data;
		if (!data || data.ok === false) {
			return { ok: false, error: data?.error ?? "Skill load failed" };
		}
		return data.skill;
	},
};

// =====================================================================
// Orchestration tools (M7)
// =====================================================================

const agentDispatch: Tool = {
	name: "agent_dispatch",
	description:
		"Spawn a sub-run on another agent. Returns immediately with the new run_id; the parent run pauses awaiting the sub-run's completion. The sub-run inherits parent_run_id; cost rolls up. Maximum nesting depth is 6.",
	parameters: {
		type: "object",
		properties: {
			agent_id: { type: "string", description: "ID of the agent to dispatch to" },
			prompt: { type: "string", description: "Goal for the sub-agent (used as initial user message)" },
			max_iterations: { type: "number" },
			max_usd: { type: "number" },
		},
		required: ["agent_id", "prompt"],
	},
	capabilities: ["network:fetch"],
	handler: async (args, ctx) => {
		if (!ctx.http) throw new Error("network:fetch capability missing");
		const baseUrl = (
			(ctx.site as { url?: string } | undefined)?.url ?? "http://localhost:4321"
		).replace(/\/$/, "");
		const res = await ctx.http.fetch(`${baseUrl}/_emdash/api/plugins/runs/runs.start`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				agent_id: asString(args.agent_id),
				prompt: asString(args.prompt),
				parent_run_id: ctx.runId,
				max_iterations: asNumber(args.max_iterations),
				max_usd: asNumber(args.max_usd),
			}),
		});
		if (!res.ok) throw new Error(`runs.start returned ${res.status}`);
		const json = (await res.json()) as {
			data?: { ok?: boolean; run?: { id: string }; error?: string };
		};
		const data = json.data;
		if (!data || data.ok === false) {
			throw new Error(data?.error ?? "runs.start returned ok:false");
		}
		const subRunId = data.run?.id;
		if (!subRunId) throw new Error("runs.start did not return a run id");
		// Tell the harness to pause awaiting this sub-run. The parent
		// resumes when the child emits run:completed (M7's
		// auto-routine subscribes and calls runs.resume).
		return {
			ok: true,
			paused_for_subrun: { run_id: subRunId },
			message: `Dispatched agent ${asString(args.agent_id)} as sub-run ${subRunId}`,
		};
	},
};

const BUILT_IN_TOOLS = [
	skillList,
	skillLoad,
	agentDispatch,
	contentList,
	contentGet,
	contentSearch,
	contentCreate,
	contentUpdate,
	contentPublish,
	contentSchedule,
	contentDelete,
	mediaUpload,
	mediaDelete,
	webFetch,
	readabilityScore,
	seoScore,
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
