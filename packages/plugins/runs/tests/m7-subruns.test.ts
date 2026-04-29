import { describe, expect, it } from "vitest";

import { isAncestor, MAX_SUBRUN_DEPTH, rollupCost, runDepth } from "../src/sub-runs.js";
import type { Run } from "../src/types.js";

const NOW = "2026-04-29T00:00:00.000Z";

function mkRun(id: string, parent_run_id?: string, cost = { tokens_in: 10, tokens_out: 5, usd: 0.01, calls: 1 }): Run {
	return {
		id,
		agent_id: "writer",
		parent_run_id,
		status: "running",
		message_history: [],
		iteration: 1,
		limits: { max_iterations: 8 },
		cost,
		cancel_requested: false,
		model: "fake",
		driver_id: "fake",
		completion_input: { model: "fake", messages: [] },
		started_at: NOW,
		updated_at: NOW,
	};
}

describe("isAncestor", () => {
	it("returns true when the target is in the parent chain", async () => {
		const a = mkRun("a");
		const b = mkRun("b", "a");
		const c = mkRun("c", "b");
		const lookup = async (id: string) => ({ a, b, c })[id as "a" | "b" | "c"] ?? null;
		expect(await isAncestor(c, "a", lookup)).toBe(true);
		expect(await isAncestor(c, "b", lookup)).toBe(true);
	});

	it("returns false when the target is not an ancestor", async () => {
		const a = mkRun("a");
		const b = mkRun("b", "a");
		const lookup = async (id: string) => ({ a, b })[id as "a" | "b"] ?? null;
		expect(await isAncestor(b, "z", lookup)).toBe(false);
	});

	it("stops at MAX_SUBRUN_DEPTH (defends against cycles)", async () => {
		// Construct a self-referential cycle.
		const x = mkRun("x", "x");
		const lookup = async () => x;
		expect(await isAncestor(x, "y", lookup)).toBe(false); // never finds y
	});
});

describe("runDepth", () => {
	it("returns 0 for root", async () => {
		const r = mkRun("r");
		expect(await runDepth(r, async () => null)).toBe(0);
	});

	it("walks the chain", async () => {
		const a = mkRun("a");
		const b = mkRun("b", "a");
		const c = mkRun("c", "b");
		const d = mkRun("d", "c");
		const lookup = async (id: string) => ({ a, b, c })[id as "a" | "b" | "c"] ?? null;
		expect(await runDepth(d, lookup)).toBe(3);
	});

	it("caps at MAX_SUBRUN_DEPTH+1 to bound a cycle", async () => {
		const x = mkRun("x", "x");
		const lookup = async () => x;
		const d = await runDepth(x, lookup);
		expect(d).toBeLessThanOrEqual(MAX_SUBRUN_DEPTH + 1);
	});
});

describe("rollupCost", () => {
	it("sums parent + transitive children", async () => {
		const root = mkRun("root", undefined, { tokens_in: 10, tokens_out: 10, usd: 0.01, calls: 1 });
		const c1 = mkRun("c1", "root", { tokens_in: 20, tokens_out: 20, usd: 0.02, calls: 2 });
		const c2 = mkRun("c2", "root", { tokens_in: 30, tokens_out: 30, usd: 0.03, calls: 3 });
		const gc = mkRun("gc", "c1", { tokens_in: 5, tokens_out: 5, usd: 0.005, calls: 1 });

		const listChildren = async (parentId: string) => {
			if (parentId === "root") return [c1, c2];
			if (parentId === "c1") return [gc];
			return [];
		};
		const total = await rollupCost(root, listChildren);
		expect(total.tokens_in).toBe(10 + 20 + 30 + 5);
		expect(total.tokens_out).toBe(10 + 20 + 30 + 5);
		expect(total.usd).toBeCloseTo(0.01 + 0.02 + 0.03 + 0.005, 5);
		expect(total.calls).toBe(1 + 2 + 3 + 1);
	});

	it("returns own cost when no children", async () => {
		const r = mkRun("r");
		const total = await rollupCost(r, async () => []);
		expect(total).toEqual(r.cost);
	});
});
