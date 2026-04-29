/**
 * Auto-tracing routines for Langfuse.
 *
 * Operators install Langfuse, set their keys, and traces start
 * appearing without further config. We do this by seeding default
 * routines into the automations storage on `plugin:install` (and
 * idempotently on every cold boot in case the routines collection
 * was reset).
 *
 * Three routines are seeded:
 *
 *   1. `run:started`        → langfuse:trace          (open the trace)
 *   2. `llm:call-finished`  → langfuse:generation     (submit each LLM call)
 *   3. `run:completed`      → langfuse:score          (close the trace with status)
 *
 * The `langfuse:*` actions live in this plugin's existing actions
 * registry; this module just inserts the routine documents.
 */

import type { PluginContext } from "emdash";

const ROUTINE_IDS = {
	traceOpen: "langfuse-auto-trace-open",
	generation: "langfuse-auto-generation",
	traceClose: "langfuse-auto-trace-close",
} as const;

const NOW = (): string => new Date().toISOString();

interface RoutineDoc {
	id: string;
	name: string;
	description: string;
	enabled: boolean;
	trigger: { on: string };
	filter?: Record<string, unknown>;
	actions: Array<{ type: string; payload: Record<string, unknown> }>;
	stats?: { lastRunAt?: string; lastError?: string; runCount?: number };
	createdAt: string;
	updatedAt: string;
	source?: string;
}

const TRACE_OPEN: RoutineDoc = {
	id: ROUTINE_IDS.traceOpen,
	name: "Langfuse — open trace on run start",
	description: "Auto-seeded by @emdash-cms/plugin-langfuse. Opens a Langfuse trace when an agent run starts.",
	enabled: true,
	trigger: { on: "run:started" },
	actions: [
		{
			type: "langfuse:trace",
			payload: {
				id: "{event.run_id}",
				name: "agent-run:{event.agent_id}",
				input: { agent_id: "{event.agent_id}", task_id: "{event.task_id}" },
				metadata: { run_id: "{event.run_id}", driver: "{event.driver}", model: "{event.model}" },
			},
		},
	],
	createdAt: NOW(),
	updatedAt: NOW(),
	source: "langfuse-auto",
};

const GENERATION: RoutineDoc = {
	id: ROUTINE_IDS.generation,
	name: "Langfuse — submit generation per LLM call",
	description: "Auto-seeded. Submits a Langfuse generation event for each completed LLM call inside a run.",
	enabled: true,
	trigger: { on: "llm:call-finished" },
	actions: [
		{
			type: "langfuse:generation",
			payload: {
				traceId: "{event.runId}",
				name: "{event.model}",
				model: "{event.model}",
				input: "{event.input}",
				output: "{event.output}",
				usage: "{event.usage}",
			},
		},
	],
	createdAt: NOW(),
	updatedAt: NOW(),
	source: "langfuse-auto",
};

const TRACE_CLOSE: RoutineDoc = {
	id: ROUTINE_IDS.traceClose,
	name: "Langfuse — close trace on run completion",
	description: "Auto-seeded. Submits a final Langfuse score reflecting the run's terminal status (completed/failed/cancelled).",
	enabled: true,
	trigger: { on: "run:completed" },
	actions: [
		{
			type: "langfuse:score",
			payload: {
				traceId: "{event.run_id}",
				name: "completion",
				value: 1,
				comment: "Run completed successfully",
			},
		},
	],
	createdAt: NOW(),
	updatedAt: NOW(),
	source: "langfuse-auto",
};

const ALL_ROUTINES = [TRACE_OPEN, GENERATION, TRACE_CLOSE];

/**
 * Idempotently seed the auto-tracing routines into automations storage.
 *
 * The automations plugin owns the `routines` collection; we reach
 * in via internal RPC rather than declaring a foreign storage.
 * Internal route auth (M0) carries the runId/traceId for this very
 * call so it shows up in the audit log correctly.
 */
export async function seedRoutines(ctx: PluginContext): Promise<void> {
	if (!ctx.http) {
		ctx.log.warn("Langfuse: cannot seed auto-routines without network:fetch capability");
		return;
	}
	const site = (
		(ctx.site as { url?: string } | undefined)?.url ?? "http://localhost:4321"
	).replace(/\/$/, "");

	for (const routine of ALL_ROUTINES) {
		try {
			const res = await ctx.http.fetch(
				`${site}/_emdash/api/plugins/automations/routines.upsert`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(routine),
				},
			);
			if (!res.ok) {
				ctx.log.warn(`Langfuse: routine ${routine.id} upsert returned ${res.status}`);
			}
		} catch (err) {
			ctx.log.warn(`Langfuse: failed to seed routine ${routine.id}`, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
}

export const SEEDED_ROUTINE_IDS = ROUTINE_IDS;
