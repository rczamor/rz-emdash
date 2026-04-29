import { describe, expect, it } from "vitest";

import { aggregateUsage, periodCutoff } from "../src/usage-summary.js";
import type { Run } from "../src/types.js";

const NOW = new Date("2026-04-29T12:00:00.000Z");

function mkRun(overrides: Partial<Run> = {}): Run {
	return {
		id: "r1",
		agent_id: "writer",
		status: "completed",
		message_history: [],
		iteration: 1,
		limits: { max_iterations: 8 },
		cost: { tokens_in: 100, tokens_out: 50, usd: 0.001, calls: 1 },
		cancel_requested: false,
		model: "haiku-4-5",
		driver_id: "openrouter",
		completion_input: { model: "haiku-4-5", messages: [] },
		started_at: NOW.toISOString(),
		updated_at: NOW.toISOString(),
		...overrides,
	};
}

describe("periodCutoff", () => {
	it("returns 24 hours ago for 24h", () => {
		expect(periodCutoff("24h", NOW)).toBe("2026-04-28T12:00:00.000Z");
	});
	it("returns 7 days ago for 7d", () => {
		expect(periodCutoff("7d", NOW)).toBe("2026-04-22T12:00:00.000Z");
	});
	it("returns epoch for 'all'", () => {
		expect(periodCutoff("all", NOW)).toBe("1970-01-01T00:00:00.000Z");
	});
});

describe("aggregateUsage", () => {
	it("buckets by agent and sums correctly", () => {
		const runs = [
			mkRun({ id: "a", agent_id: "writer", cost: { tokens_in: 10, tokens_out: 5, usd: 0.01, calls: 1 } }),
			mkRun({ id: "b", agent_id: "writer", cost: { tokens_in: 20, tokens_out: 10, usd: 0.02, calls: 2 } }),
			mkRun({ id: "c", agent_id: "editor", cost: { tokens_in: 30, tokens_out: 15, usd: 0.10, calls: 3 } }),
		];
		const summary = aggregateUsage(runs, "all", "agent", NOW);
		expect(summary.totals).toEqual({ runs: 3, tokens_in: 60, tokens_out: 30, usd: 0.13, calls: 6 });
		expect(summary.buckets).toHaveLength(2);
		// Sorted by usd descending
		expect(summary.buckets[0]?.key).toBe("editor");
		expect(summary.buckets[1]?.key).toBe("writer");
		expect(summary.buckets[1]?.runs).toBe(2);
	});

	it("filters runs older than the period cutoff", () => {
		const inWindow = mkRun({
			id: "in",
			started_at: "2026-04-29T10:00:00.000Z",
			cost: { tokens_in: 1, tokens_out: 1, usd: 0.001, calls: 1 },
		});
		const outOfWindow = mkRun({
			id: "out",
			started_at: "2026-04-01T00:00:00.000Z",
			cost: { tokens_in: 999, tokens_out: 999, usd: 1.0, calls: 99 },
		});
		const summary = aggregateUsage([inWindow, outOfWindow], "24h", "agent", NOW);
		expect(summary.totals.runs).toBe(1);
		expect(summary.totals.usd).toBeCloseTo(0.001);
	});

	it("groups by model", () => {
		const runs = [
			mkRun({ model: "haiku-4-5" }),
			mkRun({ model: "haiku-4-5" }),
			mkRun({ model: "sonnet-4-6" }),
		];
		const summary = aggregateUsage(runs, "all", "model", NOW);
		expect(summary.buckets.map((b) => b.key).sort()).toEqual(["haiku-4-5", "sonnet-4-6"]);
		expect(summary.buckets.find((b) => b.key === "haiku-4-5")!.runs).toBe(2);
	});

	it("groups by status, including failed and cancelled", () => {
		const runs = [
			mkRun({ status: "completed" }),
			mkRun({ status: "completed" }),
			mkRun({ status: "failed" }),
			mkRun({ status: "cancelled" }),
		];
		const summary = aggregateUsage(runs, "all", "status", NOW);
		expect(summary.buckets).toHaveLength(3);
	});

	it("uses '(none)' bucket for runs without a task_id when grouping by task", () => {
		const runs = [mkRun({ task_id: undefined }), mkRun({ task_id: "tsk_1" })];
		const summary = aggregateUsage(runs, "all", "task", NOW);
		expect(summary.buckets.map((b) => b.key).sort()).toEqual(["(none)", "tsk_1"]);
	});

	it("returns empty buckets when no runs match", () => {
		const summary = aggregateUsage([], "24h", "agent", NOW);
		expect(summary.buckets).toEqual([]);
		expect(summary.totals.runs).toBe(0);
	});
});
