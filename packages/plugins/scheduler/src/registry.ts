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

const handlers = new Map<string, JobHandler>();

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
	return Array.from(handlers.keys()).sort();
}

export function unregisterJobHandler(name: string): boolean {
	return handlers.delete(name);
}
