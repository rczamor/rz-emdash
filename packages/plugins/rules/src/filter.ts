/**
 * Filter evaluator — takes a structured Filter and an event, returns boolean.
 * Pure function; no side effects.
 */

import type { Filter } from "./types.js";

export function lookupPath(path: string, root: Record<string, unknown>): unknown {
	if (path === "$") return root;
	const parts = path.split(".");
	let current: unknown = root;
	for (const key of parts) {
		if (current == null) return undefined;
		if (typeof current === "object" && key in (current as object)) {
			current = (current as Record<string, unknown>)[key];
		} else {
			return undefined;
		}
	}
	return current;
}

function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (a == null || b == null) return false;
	if (typeof a !== typeof b) return false;
	if (Array.isArray(a) && Array.isArray(b)) {
		if (a.length !== b.length) return false;
		return a.every((v, i) => deepEqual(v, b[i]));
	}
	if (typeof a === "object" && typeof b === "object") {
		const ak = Object.keys(a as object);
		const bk = Object.keys(b as object);
		if (ak.length !== bk.length) return false;
		return ak.every((k) =>
			deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
		);
	}
	return false;
}

export function evaluateFilter(filter: Filter, event: Record<string, unknown>): boolean {
	if ("eq" in filter) {
		return deepEqual(lookupPath(filter.eq.path, event), filter.eq.value);
	}
	if ("ne" in filter) {
		return !deepEqual(lookupPath(filter.ne.path, event), filter.ne.value);
	}
	if ("in" in filter) {
		const value = lookupPath(filter.in.path, event);
		return filter.in.values.some((v) => deepEqual(v, value));
	}
	if ("notIn" in filter) {
		const value = lookupPath(filter.notIn.path, event);
		return !filter.notIn.values.some((v) => deepEqual(v, value));
	}
	if ("contains" in filter) {
		const value = lookupPath(filter.contains.path, event);
		return typeof value === "string" && value.includes(filter.contains.value);
	}
	if ("matches" in filter) {
		const value = lookupPath(filter.matches.path, event);
		if (typeof value !== "string") return false;
		try {
			return new RegExp(filter.matches.pattern, filter.matches.flags ?? "").test(value);
		} catch {
			return false;
		}
	}
	if ("gt" in filter) {
		const v = lookupPath(filter.gt.path, event);
		return typeof v === "number" && v > filter.gt.value;
	}
	if ("gte" in filter) {
		const v = lookupPath(filter.gte.path, event);
		return typeof v === "number" && v >= filter.gte.value;
	}
	if ("lt" in filter) {
		const v = lookupPath(filter.lt.path, event);
		return typeof v === "number" && v < filter.lt.value;
	}
	if ("lte" in filter) {
		const v = lookupPath(filter.lte.path, event);
		return typeof v === "number" && v <= filter.lte.value;
	}
	if ("exists" in filter) {
		return lookupPath(filter.exists.path, event) !== undefined;
	}
	if ("all" in filter) {
		return filter.all.every((f) => evaluateFilter(f, event));
	}
	if ("any" in filter) {
		return filter.any.some((f) => evaluateFilter(f, event));
	}
	if ("not" in filter) {
		return !evaluateFilter(filter.not, event);
	}
	return false;
}
