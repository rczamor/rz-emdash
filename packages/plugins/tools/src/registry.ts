/**
 * Tool registry — module-scoped singleton.
 *
 * Plugins or user code call `registerTool(tool)` at module-load time
 * (typically from a sandbox entry's top-level scope, not inside a
 * handler). The Tools plugin's runtime entrypoint seeds the
 * built-ins on load, so by the time the OpenRouter chat loop calls
 * `getTool(name)`, every registered tool is reachable.
 *
 * Trusted-mode-only singleton; same constraint as the automations
 * action registry. Sandboxed plugins each get their own copy of this
 * module and therefore their own (built-ins-only) registry.
 */

import type { Tool } from "./types.js";

const TOOLS_REGISTRY_STATE = Symbol.for("emdash.pluginTools.registry");

interface ToolsRegistryState {
	registry: Map<string, Tool>;
}

type ToolsRegistryGlobal = typeof globalThis & {
	[TOOLS_REGISTRY_STATE]?: ToolsRegistryState;
};

function getRegistryState(): ToolsRegistryState {
	const global = globalThis as ToolsRegistryGlobal;
	global[TOOLS_REGISTRY_STATE] ??= { registry: new Map() };
	return global[TOOLS_REGISTRY_STATE];
}

const registry = getRegistryState().registry;

export function registerTool(tool: Tool): void {
	if (!tool.name || !tool.description || !tool.parameters || !tool.handler) {
		throw new Error("Tool requires name, description, parameters, and handler");
	}
	if (registry.has(tool.name)) {
		console.warn(`[tools] tool "${tool.name}" already registered — overwriting.`);
	}
	registry.set(tool.name, tool);
}

export function getTool(name: string): Tool | undefined {
	return registry.get(name);
}

export function listTools(): Tool[] {
	return [...registry.values()].toSorted((a, b) => a.name.localeCompare(b.name));
}

export function listToolNames(): string[] {
	return [...registry.keys()].toSorted();
}

export function unregisterTool(name: string): boolean {
	return registry.delete(name);
}

/** Internal — used by built-ins.ts to seed defaults. */
export function _registerBuiltin(tool: Tool): void {
	if (registry.has(tool.name)) return;
	registry.set(tool.name, tool);
}

/** @internal — test hook for clearing the registry between cases. */
export function _resetTools(): void {
	registry.clear();
}
