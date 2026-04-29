/**
 * Runs Plugin for EmDash CMS — agent-run harness.
 *
 * Today's chat-completion loops are fire-and-forget: they iterate
 * tool calls in memory until the model stops, return the final
 * message, and forget everything. Long runs can't be paused,
 * cancelled, resumed, or supervised. This plugin makes the run a
 * first-class entity:
 *
 *   - `runs` storage holds the persisted Run with its full message
 *     history, cost ledger, and limits.
 *   - `run_events` storage is the append-only event log used for
 *     timelines, replay, and (M4) live streaming.
 *
 * A run advances by enqueueing a `runs:tick` custom job on the
 * scheduler — each iteration is its own request, so the harness
 * works on Cloudflare Workers (no long-lived process required).
 *
 * The runs plugin owns the loop; downstream plugins (tools,
 * agents, langfuse) interact with runs via internal RPC and the
 * `run:*` event family.
 */

import type { PluginDescriptor } from "emdash";

export type {
	Run,
	RunCost,
	RunEvent,
	RunEventKind,
	RunError,
	RunLimits,
	RunPause,
	RunStatus,
	StartRunInput,
} from "./types.js";

export interface RunsPluginOptions {
	/**
	 * Default per-run cap on iterations. A run that hits this without
	 * terminating is marked `failed` with `limit-hit`. Default 16.
	 */
	defaultMaxIterations?: number;
	/**
	 * Default per-run wallclock cap in ms. Default 10 minutes.
	 * Operators with long-form drafts may want higher.
	 */
	defaultMaxWallclockMs?: number;
}

export function runsPlugin(_options: RunsPluginOptions = {}): PluginDescriptor {
	return {
		id: "runs",
		version: "0.0.1",
		format: "standard",
		entrypoint: "@emdash-cms/plugin-runs/sandbox",
		options: {},
		// `read:users` so we can stamp run audit entries with the actor;
		// `network:fetch` for internal RPC to the llm-router driver and
		// scheduler. Run mutations write to plugin storage only — no
		// `write:content` here; tools that touch content live in the
		// tools plugin behind their own capability checks.
		capabilities: ["read:users", "network:fetch"],
		allowedHosts: [],
		storage: {
			runs: {
				indexes: ["agent_id", "task_id", "parent_run_id", "status", "started_at"],
			},
			run_events: {
				indexes: ["run_id", "ordinal", "kind"],
			},
		},
		adminPages: [{ path: "/runs", label: "Runs", icon: "play-circle" }],
	};
}
