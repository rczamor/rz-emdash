/**
 * Agents Plugin for EmDash CMS — agent registry, skills allowlist,
 * tools allowlist, identity files, memory partitioned by agent_id.
 *
 * The Tasks plugin's polymorphic assignee namespace ("agent:<id>")
 * maps to rows in this plugin's `agents` storage. Other plugins
 * (OpenRouter, Tools) consult the Agents plugin to compile a system
 * prompt + apply per-agent quotas + filter the tool catalog.
 *
 * Identity-as-files (OpenClaw pattern) lives on the Agent row as
 * markdown text fields. Editing happens in the Block Kit admin OR
 * via the API. A future companion CLI will sync DB ↔ filesystem so
 * agent identity can also be Git-tracked.
 *
 * Memory is high-write — a Postgres-backed plugin storage table
 * keyed by `agent_id + key`, with importance + recency for the
 * `memory.search` retrieval.
 *
 * Skills are not duplicated here — they live in a content collection
 * (default `agent_skills`) that the user defines via seed.json.
 * `agent.skills[]` is just an allowlist of slugs.
 */

import type { PluginDescriptor } from "emdash";

export type {
	Agent,
	AgentModel,
	AgentQuotas,
	CompiledAgentContext,
	CreateAgentInput,
	MemoryEntry,
	MemoryPutInput,
	MemorySearchInput,
	UpdateAgentInput,
} from "./types.js";

export function agentsPlugin(): PluginDescriptor {
	return {
		id: "agents",
		version: "0.0.1",
		format: "standard",
		entrypoint: "@emdash-cms/plugin-agents/sandbox",
		options: {},
		capabilities: ["read:content", "read:users"],
		storage: {
			agents: {
				indexes: ["active", "role", "created_at"],
			},
			memory: {
				// Index by agent_id + key for fast partition reads.
				// Index by importance for ranking. Tags as their own index
				// for tag filtering.
				indexes: [
					"agent_id",
					"key",
					["agent_id", "key"],
					"importance",
					"last_accessed_at",
				],
			},
		},
		adminPages: [{ path: "/agents", label: "Agents", icon: "user-circle" }],
		adminWidgets: [{ id: "agents-active", title: "Active agents", size: "half" }],
	};
}
