/**
 * Cost / usage rollup over runs.
 *
 * Reads the `runs` collection and aggregates `cost` per dimension
 * (agent / task / model). Storage is naturally indexed on those
 * fields so the query is cheap even with thousands of runs.
 *
 * The aggregation runs server-side — clients call `runs.usageSummary`
 * with `period=24h|7d|30d` and `group_by=agent|task|model`.
 */

import type { Run } from "./types.js";

export type UsagePeriod = "24h" | "7d" | "30d" | "all";
export type UsageGroup = "agent" | "task" | "model" | "status";

export interface UsageBucket {
	key: string;
	runs: number;
	tokens_in: number;
	tokens_out: number;
	usd: number;
	calls: number;
}

export interface UsageSummary {
	period: UsagePeriod;
	group_by: UsageGroup;
	since: string;
	totals: Omit<UsageBucket, "key">;
	buckets: UsageBucket[];
}

const PERIOD_MS: Record<UsagePeriod, number> = {
	"24h": 24 * 60 * 60 * 1000,
	"7d": 7 * 24 * 60 * 60 * 1000,
	"30d": 30 * 24 * 60 * 60 * 1000,
	all: Number.POSITIVE_INFINITY,
};

export function periodCutoff(period: UsagePeriod, now: Date = new Date()): string {
	const ms = PERIOD_MS[period];
	if (!Number.isFinite(ms)) return "1970-01-01T00:00:00.000Z";
	return new Date(now.getTime() - ms).toISOString();
}

function bucketKey(run: Run, group: UsageGroup): string {
	switch (group) {
		case "agent":
			return run.agent_id;
		case "task":
			return run.task_id ?? "(none)";
		case "model":
			return run.model;
		case "status":
			return run.status;
	}
}

/** Aggregate a list of Runs into a UsageSummary. Pure function. */
export function aggregateUsage(
	runs: Run[],
	period: UsagePeriod,
	group: UsageGroup,
	now: Date = new Date(),
): UsageSummary {
	const since = periodCutoff(period, now);
	const filtered = runs.filter((r) => r.started_at >= since);

	const buckets = new Map<string, UsageBucket>();
	const totals = { runs: 0, tokens_in: 0, tokens_out: 0, usd: 0, calls: 0 };

	for (const run of filtered) {
		totals.runs += 1;
		totals.tokens_in += run.cost.tokens_in;
		totals.tokens_out += run.cost.tokens_out;
		totals.usd += run.cost.usd;
		totals.calls += run.cost.calls;

		const key = bucketKey(run, group);
		let b = buckets.get(key);
		if (!b) {
			b = { key, runs: 0, tokens_in: 0, tokens_out: 0, usd: 0, calls: 0 };
			buckets.set(key, b);
		}
		b.runs += 1;
		b.tokens_in += run.cost.tokens_in;
		b.tokens_out += run.cost.tokens_out;
		b.usd += run.cost.usd;
		b.calls += run.cost.calls;
	}

	return {
		period,
		group_by: group,
		since,
		totals,
		buckets: Array.from(buckets.values()).sort((a, b) => b.usd - a.usd),
	};
}
