/**
 * Pluggable handler registry for `custom` job types.
 *
 * Other plugins / user code register handlers at module-load time:
 *
 *   import { registerJobHandler } from "@emdash-cms/plugin-scheduler/registry";
 *
 *   registerJobHandler("audit:cleanup", async (data, ctx) => {
 *     await ctx.kv.delete(`audit:${data.id}`);
 *   });
 *
 * Then create a job of type "custom" with `payload: { handler: "audit:cleanup", data: {...} }`.
 *
 * Trusted-mode-only singleton; same constraint as the automations
 * action registry. Sandboxed plugins each get their own (empty) copy.
 */

import type { PluginContext } from "emdash";

export type JobHandler = (
	data: Record<string, unknown> | undefined,
	ctx: PluginContext,
) => Promise<void>;

const SCHEDULER_REGISTRY_STATE = Symbol.for("emdash.pluginScheduler.registry");

interface SchedulerRegistryState {
	handlers: Map<string, JobHandler>;
}

type SchedulerRegistryGlobal = typeof globalThis & {
	[SCHEDULER_REGISTRY_STATE]?: SchedulerRegistryState;
};

function getRegistryState(): SchedulerRegistryState {
	const global = globalThis as SchedulerRegistryGlobal;
	global[SCHEDULER_REGISTRY_STATE] ??= { handlers: new Map() };
	return global[SCHEDULER_REGISTRY_STATE];
}

const handlers = getRegistryState().handlers;

export function registerJobHandler(name: string, handler: JobHandler): void {
	if (handlers.has(name)) {
		console.warn(`[scheduler] handler "${name}" already registered — overwriting.`);
	}
	handlers.set(name, handler);
}

export function getJobHandler(name: string): JobHandler | undefined {
	return handlers.get(name);
}

export function listJobHandlers(): string[] {
	return [...handlers.keys()].toSorted();
}

export function unregisterJobHandler(name: string): boolean {
	return handlers.delete(name);
}

/** @internal — test hook for clearing the registry between cases. */
export function _resetJobHandlers(): void {
	handlers.clear();
}
