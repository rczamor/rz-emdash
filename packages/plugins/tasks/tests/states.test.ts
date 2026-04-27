import { describe, it, expect } from "vitest";

import { allTransitions, canTransition, isTerminal, TERMINAL } from "../src/states.js";
import type { TaskStatus } from "../src/types.js";

const ALL_STATES: TaskStatus[] = [
	"backlog",
	"in_progress",
	"pending_review",
	"approved",
	"rejected",
	"published",
	"cancelled",
];

describe("canTransition — allowed paths", () => {
	const allowed: Array<[TaskStatus, TaskStatus]> = [
		["backlog", "in_progress"],
		["backlog", "cancelled"],
		["in_progress", "pending_review"],
		["in_progress", "cancelled"],
		["pending_review", "approved"],
		["pending_review", "rejected"],
		["pending_review", "in_progress"],
		["rejected", "in_progress"],
		["rejected", "cancelled"],
		["approved", "published"],
		["approved", "rejected"],
		["approved", "in_progress"],
		["published", "in_progress"],
	];
	for (const [from, to] of allowed) {
		it(`${from} → ${to} is allowed`, () => {
			expect(canTransition(from, to)).toBe(true);
		});
	}
});

describe("canTransition — disallowed paths", () => {
	const disallowed: Array<[TaskStatus, TaskStatus]> = [
		// Cannot skip in_progress when leaving backlog (no review-skip)
		["backlog", "pending_review"],
		["backlog", "approved"],
		["backlog", "published"],
		// In progress cannot leap to terminal
		["in_progress", "published"],
		["in_progress", "approved"],
		// Cancelled is terminal
		["cancelled", "in_progress"],
		["cancelled", "backlog"],
		// Same-status not allowed (no-op should be skipped before this check)
		["in_progress", "in_progress"],
	];
	for (const [from, to] of disallowed) {
		it(`${from} → ${to} is disallowed`, () => {
			expect(canTransition(from, to)).toBe(false);
		});
	}
});

describe("allTransitions", () => {
	it("backlog allows in_progress + cancelled", () => {
		expect(allTransitions("backlog").toSorted()).toEqual(["cancelled", "in_progress"]);
	});

	it("cancelled has no transitions", () => {
		expect(allTransitions("cancelled")).toEqual([]);
	});

	it("approved allows three transitions", () => {
		expect(allTransitions("approved").toSorted()).toEqual(["in_progress", "published", "rejected"]);
	});

	it("every state's allTransitions agrees with canTransition", () => {
		for (const from of ALL_STATES) {
			const allowed = allTransitions(from);
			for (const to of ALL_STATES) {
				const isAllowed = allowed.includes(to);
				expect(canTransition(from, to)).toBe(isAllowed);
			}
		}
	});
});

describe("isTerminal", () => {
	it("published is terminal", () => {
		expect(isTerminal("published")).toBe(true);
	});

	it("cancelled is terminal", () => {
		expect(isTerminal("cancelled")).toBe(true);
	});

	it("non-terminal states are not terminal", () => {
		expect(isTerminal("backlog")).toBe(false);
		expect(isTerminal("in_progress")).toBe(false);
		expect(isTerminal("pending_review")).toBe(false);
		expect(isTerminal("approved")).toBe(false);
		expect(isTerminal("rejected")).toBe(false);
	});

	it("TERMINAL list contains exactly published + cancelled", () => {
		expect(TERMINAL.toSorted()).toEqual(["cancelled", "published"]);
	});
});

describe("graph reachability", () => {
	it("every state is reachable from backlog (except cancelled, which is also reachable)", () => {
		// Walk forward through allTransitions from backlog and verify
		// every other state can be reached.
		const visited = new Set<TaskStatus>(["backlog"]);
		const queue: TaskStatus[] = ["backlog"];
		while (queue.length > 0) {
			const cur = queue.shift()!;
			for (const next of allTransitions(cur)) {
				if (!visited.has(next)) {
					visited.add(next);
					queue.push(next);
				}
			}
		}
		for (const state of ALL_STATES) {
			expect(visited.has(state)).toBe(true);
		}
	});

	it("approved cannot transition to backlog (no full reset)", () => {
		expect(canTransition("approved", "backlog")).toBe(false);
	});
});
