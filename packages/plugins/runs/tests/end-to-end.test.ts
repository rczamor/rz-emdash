import { describe, expect, it } from "vitest";

import { tickRun } from "../src/loop.js";
import type { Run, RunEvent } from "../src/types.js";

import {
	FakeStorage,
	makeContext,
	makeDriver,
	stopResponse,
	toolCallResponse,
} from "./_helpers.js";

const NOW = "2026-04-29T00:00:00.000Z";

function makeRun(overrides: Partial<Run> = {}): Run {
	return {
		id: "run_e2e",
		agent_id: "writer",
		status: "queued",
		message_history: [{ role: "user", content: "use the tool" }],
		iteration: 0,
		limits: { max_iterations: 8 },
		cost: { tokens_in: 0, tokens_out: 0, usd: 0, calls: 0 },
		cancel_requested: false,
		model: "fake-model",
		driver_id: "fake",
		completion_input: { model: "fake-model", messages: [] },
		started_at: NOW,
		updated_at: NOW,
		...overrides,
	};
}

describe("end-to-end: multi-iteration tool-calling run", () => {
	it("iteration 1 calls a tool; iteration 2 stops; final state is completed", async () => {
		const runs = new FakeStorage<Run>();
		const events = new FakeStorage<RunEvent>();

		// Stub tools.invoke
		const toolCalls: { url: string; body: unknown }[] = [];
		const httpFetch = async (input: string | URL | Request, init?: RequestInit) => {
			const body = init?.body ? JSON.parse(init.body as string) : null;
			toolCalls.push({ url: String(input), body });
			return new Response(
				JSON.stringify({ data: { ok: true, output: { items: ["a", "b"] } } }),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		};
		const ctx = makeContext({
			runs,
			runEvents: events,
			http: { fetch: httpFetch as unknown as typeof fetch },
		});

		await runs.put("run_e2e", makeRun({ tools: [] }));

		// Driver: iteration 1 returns tool_call; iteration 2 returns stop.
		const driver = makeDriver([
			toolCallResponse("content_list", { collection: "posts" }),
			stopResponse("Here are the items: a, b"),
		]);
		const deps = {
			resolveDriver: () => driver,
			siteUrl: "http://localhost:4321",
		};

		// Iteration 1
		const tick1 = await tickRun("run_e2e", ctx, deps);
		expect(tick1.scheduleNextTick).toBe(true);
		expect(tick1.run.status).toBe("running");
		expect(tick1.run.iteration).toBe(1);
		expect(tick1.run.message_history.filter((m) => m.role === "tool")).toHaveLength(1);

		// Iteration 2 — happens in a fresh tick (mimics the scheduler firing
		// the next runs:tick job). The harness loads the run by id.
		const tick2 = await tickRun("run_e2e", ctx, deps);
		expect(tick2.done).toBe(true);
		expect(tick2.run.status).toBe("completed");
		expect(tick2.run.iteration).toBe(2);
		expect(tick2.run.message_history.at(-1)?.content).toBe("Here are the items: a, b");

		// Tool was invoked once between iterations.
		expect(toolCalls).toHaveLength(1);
		expect(toolCalls[0]?.url).toMatch(/tools\.invoke$/);
		expect((toolCalls[0]?.body as { name: string }).name).toBe("content_list");
		// Tool invocation carried agentId so the allowlist check in tools.invoke runs.
		expect((toolCalls[0]?.body as { agentId: string }).agentId).toBe("writer");

		// Event log captures the full run shape.
		const sortedEvents = Array.from(events.items.values()).sort((a, b) => a.ordinal - b.ordinal);
		const kinds = sortedEvents.map((e) => e.kind);
		expect(kinds).toEqual([
			"iteration-started",
			"llm-call",
			"tool-call",
			"iteration-started",
			"llm-call",
			"run-completed",
		]);
		expect(sortedEvents.map((e) => e.ordinal)).toEqual([0, 1, 2, 3, 4, 5]);

		// Cost rolled up across calls.
		expect(tick2.run.cost.calls).toBe(2);
		expect(tick2.run.cost.tokens_in).toBeGreaterThan(0);
	});

	it("resumes correctly after a simulated process restart between ticks", async () => {
		const runs = new FakeStorage<Run>();
		const events = new FakeStorage<RunEvent>();
		const httpFetch = async () =>
			new Response(JSON.stringify({ data: { ok: true, output: null } }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		const ctx = makeContext({
			runs,
			runEvents: events,
			http: { fetch: httpFetch as unknown as typeof fetch },
		});

		await runs.put("run_e2e", makeRun({ tools: [] }));

		// First tick: returns a tool call, schedules another tick.
		const driver1 = makeDriver([toolCallResponse("noop", {})]);
		await tickRun("run_e2e", ctx, {
			resolveDriver: () => driver1,
			siteUrl: "http://localhost:4321",
		});

		// Simulate process restart by snapshotting the run state and
		// reconstructing only ctx + driver (storage carries through).
		const snapshot = runs.items.get("run_e2e");
		expect(snapshot?.status).toBe("running");
		expect(snapshot?.iteration).toBe(1);
		expect(snapshot?.message_history).toHaveLength(3); // user + assistant(tool_calls) + tool result

		// Fresh ctx, fresh driver (next iteration completes).
		const ctx2 = makeContext({
			runs,
			runEvents: events,
			http: { fetch: httpFetch as unknown as typeof fetch },
		});
		const driver2 = makeDriver([stopResponse("done after restart")]);
		const tick2 = await tickRun("run_e2e", ctx2, {
			resolveDriver: () => driver2,
			siteUrl: "http://localhost:4321",
		});

		expect(tick2.run.status).toBe("completed");
		expect(tick2.run.iteration).toBe(2);
		// Message history is preserved across the restart.
		expect(tick2.run.message_history.map((m) => m.role)).toEqual([
			"user",
			"assistant",
			"tool",
			"assistant",
		]);
	});
});
