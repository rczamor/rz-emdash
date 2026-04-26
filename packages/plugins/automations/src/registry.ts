/**
 * Pluggable action registry.
 *
 * Custom action types are registered here at module-load time. Other
 * plugins (or user code in `astro.config.mjs`) import this module and
 * call `registerAction(...)` once. The Automations engine looks up
 * actions via `getAction()` at execution time.
 *
 * Constraint: the registry is a module-scoped singleton. It works
 * across all plugins running in the same process (the trusted-mode
 * default). It does NOT cross V8 isolate boundaries — sandboxed
 * plugins each get their own copy of this module and therefore their
 * own (empty-by-default) registry. Until emdash exposes a runtime
 * cross-isolate plugin API, custom actions only work in trusted mode.
 *
 * Built-in actions are auto-registered when the Automations plugin's
 * runtime entrypoint loads.
 */

import type { PluginContext } from "emdash";

import type { Action } from "./types.js";

export type ActionRunner<A extends Action = Action> = (
	action: A,
	tokenCtx: Record<string, unknown>,
	ctx: PluginContext,
) => Promise<void>;

const registry = new Map<string, ActionRunner>();

export function registerAction<A extends Action>(type: A["type"], runner: ActionRunner<A>): void {
	if (registry.has(type)) {
		// Last writer wins. A console warn is enough; this is a dev-time
		// configuration concern, not a runtime error.
		console.warn(`[automations] action type "${type}" was already registered — overwriting.`);
	}
	registry.set(type, runner as ActionRunner);
}

export function getAction(type: string): ActionRunner | undefined {
	return registry.get(type);
}

export function listActionTypes(): string[] {
	return Array.from(registry.keys()).sort();
}

export function unregisterAction(type: string): boolean {
	return registry.delete(type);
}

/** Internal — used by `actions.ts` to seed the built-ins. */
export function _registerBuiltin<A extends Action>(
	type: A["type"],
	runner: ActionRunner<A>,
): void {
	if (registry.has(type)) return;
	registry.set(type, runner as ActionRunner);
}
