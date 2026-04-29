/**
 * Validation gate registry.
 *
 * `content_publish` (and other write tools that opt in) runs the
 * pluggable validation pipeline before pausing for human approval.
 * Hard fails (severity: "fail") block the publish entirely; the
 * agent is told to revise. Warnings are surfaced to the approver
 * but don't block.
 *
 * Validators register at module load via `registerValidator`. The
 * registry lives on globalThis so multiple imports of this module
 * share the same set even when bundlers duplicate code across
 * chunks.
 */

import type { PluginContext } from "emdash";

export interface ValidatorContext {
	/** The collection slug being validated. */
	collection: string;
	/** The content data about to be written. */
	data: Record<string, unknown>;
	/** The id of the existing item, if updating; null on create. */
	id: string | null;
	/** Plugin context, in case a validator needs ctx.http or ctx.kv. */
	plugin: PluginContext;
}

export type ValidatorSeverity = "pass" | "warn" | "fail";

export interface ValidationFinding {
	severity: ValidatorSeverity;
	source: string;
	message: string;
	details?: Record<string, unknown>;
}

export interface Validator {
	/** Stable id (`brand`, `moderation`, `seo`). Used for logs + dedup. */
	id: string;
	/** Human-readable name surfaced to the approver. */
	name: string;
	/** Run the validator. May call `ctx.http.fetch` to internal plugins. */
	run(input: ValidatorContext): Promise<ValidationFinding[]>;
}

const REGISTRY_KEY = Symbol.for("emdash.pluginRuns.validatorRegistry");

interface RegistryState {
	validators: Map<string, Validator>;
}

type RegistryGlobal = typeof globalThis & {
	[REGISTRY_KEY]?: RegistryState;
};

function getRegistry(): RegistryState {
	const g = globalThis as RegistryGlobal;
	g[REGISTRY_KEY] ??= { validators: new Map() };
	return g[REGISTRY_KEY];
}

export function registerValidator(v: Validator): void {
	getRegistry().validators.set(v.id, v);
}

export function unregisterValidator(id: string): boolean {
	return getRegistry().validators.delete(id);
}

export function listValidators(): Validator[] {
	return Array.from(getRegistry().validators.values()).sort((a, b) => a.id.localeCompare(b.id));
}

/** @internal — for tests. */
export function _resetValidators(): void {
	getRegistry().validators.clear();
}

export interface ValidationReport {
	ok: boolean; // false if any fail
	findings: ValidationFinding[];
}

/** Run every registered validator; aggregate findings. */
export async function runValidators(input: ValidatorContext): Promise<ValidationReport> {
	const validators = listValidators();
	const findings: ValidationFinding[] = [];
	for (const v of validators) {
		try {
			const out = await v.run(input);
			findings.push(...out);
		} catch (err) {
			findings.push({
				severity: "warn",
				source: v.id,
				message: `Validator '${v.id}' threw: ${err instanceof Error ? err.message : String(err)}`,
			});
		}
	}
	return { ok: !findings.some((f) => f.severity === "fail"), findings };
}
