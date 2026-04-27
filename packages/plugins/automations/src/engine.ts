/**
 * Routine engine — wires triggers to filters to actions.
 */

import type { PluginContext } from "emdash";

import { runAction } from "./actions.js";
import { evaluateFilter } from "./filter.js";
import type { Routine } from "./types.js";

export const ROUTINE_INDEX_KEY = "routines:index";

/** Look up routines that fire on a given trigger source. */
export async function findRoutinesFor(source: string, ctx: PluginContext): Promise<Routine[]> {
	const result = await ctx.storage.routines!.query({
		where: { triggerOn: source },
		limit: 1000,
	});
	const out: Routine[] = [];
	for (const item of result.items) {
		const r = item.data as Routine;
		if (r.enabled) out.push(r);
	}
	return out;
}

/** Run a single routine against an event. Updates stats. */
export async function executeRoutine(
	routine: Routine,
	event: Record<string, unknown>,
	siteName: string,
	ctx: PluginContext,
): Promise<void> {
	if (routine.filter) {
		if (!evaluateFilter(routine.filter, { event })) return;
	}

	const tokenCtx = {
		event,
		site: { name: siteName },
		routine: { id: routine.id, name: routine.name },
	};

	let lastError: string | undefined;
	for (const action of routine.actions) {
		try {
			await runAction(action, tokenCtx, ctx);
		} catch (err) {
			lastError = err instanceof Error ? err.message : String(err);
			ctx.log.error("Automations: action failed", {
				routineId: routine.id,
				actionType: action.type,
				error: lastError,
			});
			break;
		}
	}

	const updated: Routine = {
		...routine,
		stats: {
			lastRunAt: new Date().toISOString(),
			lastError,
			runCount: (routine.stats?.runCount ?? 0) + 1,
		},
	};
	try {
		await ctx.storage.routines!.put(routine.id, updated);
	} catch {
		// Stats writes are best effort.
	}
}

/** Dispatch a triggered event to every matching routine. */
export async function dispatchEvent(
	source: string,
	event: Record<string, unknown>,
	ctx: PluginContext,
): Promise<void> {
	const matched = await findRoutinesFor(source, ctx);
	if (matched.length === 0) return;
	const siteName = ctx.site?.name ?? "Site";
	for (const r of matched) {
		try {
			await executeRoutine(r, event, siteName, ctx);
		} catch (err) {
			ctx.log.error("Automations: routine threw", {
				routineId: r.id,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
}

/** Reconcile cron schedules with the registered routines. */
export async function reconcileCron(ctx: PluginContext): Promise<void> {
	if (!ctx.cron) return;
	const result = await ctx.storage.routines!.query({
		where: { triggerOn: "cron" },
		limit: 1000,
	});
	const wanted = new Map<string, string>();
	for (const item of result.items) {
		const r = item.data as Routine;
		if (r.enabled && r.trigger.on === "cron") {
			wanted.set(r.id, r.trigger.schedule);
		}
	}
	const existing = await ctx.cron.list();
	const existingMap = new Map(existing.map((e) => [e.name, e.schedule]));

	// Add/update
	for (const [name, schedule] of wanted) {
		if (existingMap.get(name) !== schedule) {
			await ctx.cron.schedule(name, { schedule });
		}
	}
	// Remove ones we no longer want
	for (const e of existing) {
		if (!wanted.has(e.name)) {
			await ctx.cron.cancel(e.name);
		}
	}
}
