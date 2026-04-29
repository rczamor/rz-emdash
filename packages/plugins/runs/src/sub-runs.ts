/**
 * Sub-run cycle detection + cost rollup.
 *
 * Sub-run support: any Run can declare `parent_run_id`. The harness
 * uses this for two things:
 *   1. Walk the chain on dispatch to refuse cycles + enforce a
 *      6-deep nesting cap.
 *   2. Roll up child cost into the parent on read (computed, not
 *      stored — keeps both sides authoritative).
 */

import type { Run } from "./types.js";

export const MAX_SUBRUN_DEPTH = 6;

/**
 * Walk the parent chain of `run` looking for `targetId`. Used to
 * detect cycles before dispatching: an agent must not dispatch one
 * of its own ancestors.
 */
export async function isAncestor(
	run: Run,
	targetId: string,
	loadRun: (id: string) => Promise<Run | null>,
): Promise<boolean> {
	let cur: string | undefined = run.parent_run_id;
	let depth = 0;
	while (cur && depth < MAX_SUBRUN_DEPTH) {
		if (cur === targetId) return true;
		const parent = await loadRun(cur);
		cur = parent?.parent_run_id;
		depth++;
	}
	return false;
}

/**
 * Compute the depth of `run` from the root (root has depth 0).
 * Used to refuse `agent_dispatch` past the depth cap.
 */
export async function runDepth(
	run: Run,
	loadRun: (id: string) => Promise<Run | null>,
): Promise<number> {
	let depth = 0;
	let cur: string | undefined = run.parent_run_id;
	while (cur && depth < MAX_SUBRUN_DEPTH + 1) {
		const parent = await loadRun(cur);
		cur = parent?.parent_run_id;
		depth++;
	}
	return depth;
}

/**
 * Sum the cost of `run` plus all transitive sub-runs. Cheap when
 * runs are flat; bounded by `MAX_SUBRUN_DEPTH` for nested cases.
 *
 * `listChildren(parentId)` should return direct children only —
 * the recursion is in this function so sub-run plugins don't have
 * to know about the depth cap.
 */
export async function rollupCost(
	run: Run,
	listChildren: (parentId: string) => Promise<Run[]>,
	depth = 0,
): Promise<{ tokens_in: number; tokens_out: number; usd: number; calls: number }> {
	if (depth >= MAX_SUBRUN_DEPTH) return run.cost;
	const total = { ...run.cost };
	const children = await listChildren(run.id);
	for (const child of children) {
		const sub = await rollupCost(child, listChildren, depth + 1);
		total.tokens_in += sub.tokens_in;
		total.tokens_out += sub.tokens_out;
		total.usd += sub.usd;
		total.calls += sub.calls;
	}
	return total;
}
