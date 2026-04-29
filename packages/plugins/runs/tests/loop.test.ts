import { describe, expect, it } from "vitest";

import { tickRun } from "../src/loop.js";
import type { Run, RunEvent } from "../src/types.js";

import { FakeStorage, makeContext, makeDriver, stopResponse, toolCallResponse } from "./_helpers.js";

const NOW = "2026-04-29T00:00:00.000Z";

function makeRun(overrides: Partial<Run> = {}): Run {
	return {
		id: "run_test",
		agent_id: "writer",
		status: "queued",
		message_history: [{ role: "user", content: "hi" }],
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

describe("tickRun — happy path", () => {
	it("runs a single-iteration completion to completed", async () => {
		const runs = new FakeStorage<Run>();
		const events = new FakeStorage<RunEvent>();
		const ctx = makeContext({ runs, runEvents: events });
		const run = makeRun();
		await runs.put(run.id, run);

		const driver = makeDriver([stopResponse("done")]);
		const result = await tickRun(run.id, ctx, {
			resolveDriver: () => driver,
			siteUrl: "http://localhost:4321",
		});

		expect(result.done).toBe(true);
		expect(result.scheduleNextTick).toBe(false);
		expect(result.run.status).toBe("completed");
		expect(result.run.iteration).toBe(1);
		expect(result.run.message_history).toHaveLength(2);
		expect(result.run.message_history[1]?.content).toBe("done");
		expect(result.run.cost.calls).toBe(1);
		expect(result.run.cost.tokens_in).toBe(10);
		expect(result.run.cost.tokens_out).toBe(20);
	});

	it("emits run-started? no — start-event is owned by routes; tick emits iteration/llm/completed", async () => {
		const runs = new FakeStorage<Run>();
		const events = new FakeStorage<RunEvent>();
		const ctx = makeContext({ runs, runEvents: events });
		await runs.put("run_test", makeRun());

		await tickRun("run_test", ctx, {
			resolveDriver: () => makeDriver([stopResponse("done")]),
			siteUrl: "http://localhost:4321",
		});

		const kinds = Array.from(events.items.values())
			.sort((a, b) => a.ordinal - b.ordinal)
			.map((e) => e.kind);
		expect(kinds).toEqual(["iteration-started", "llm-call", "run-completed"]);
	});

	it("estimates USD cost from usage", async () => {
		const runs = new FakeStorage<Run>();
		const events = new FakeStorage<RunEvent>();
		const ctx = makeContext({ runs, runEvents: events });
		await runs.put("run_test", makeRun());

		const result = await tickRun("run_test", ctx, {
			resolveDriver: () => makeDriver([stopResponse("done")]),
			siteUrl: "http://localhost:4321",
		});
		// 10 input @ $0.50/M + 20 output @ $1.50/M
		expect(result.run.cost.usd).toBeCloseTo(10 * 5e-7 + 20 * 1.5e-6, 10);
	});
});

describe("tickRun — cancellation", () => {
	it("respects cancel_requested without calling the driver", async () => {
		const runs = new FakeStorage<Run>();
		const events = new FakeStorage<RunEvent>();
		const ctx = makeContext({ runs, runEvents: events });
		const captured: unknown[] = [];
		const driver = makeDriver([stopResponse("should-not-run")], captured as never);

		await runs.put("run_test", makeRun({ cancel_requested: true }));
		const result = await tickRun("run_test", ctx, {
			resolveDriver: () => driver,
			siteUrl: "http://localhost:4321",
		});

		expect(result.run.status).toBe("cancelled");
		expect(captured).toHaveLength(0);
		const kinds = Array.from(events.items.values()).map((e) => e.kind);
		expect(kinds).toContain("run-cancelled");
	});
});

describe("tickRun — limits", () => {
	it("fails when max_iterations reached", async () => {
		const runs = new FakeStorage<Run>();
		const events = new FakeStorage<RunEvent>();
		const ctx = makeContext({ runs, runEvents: events });
		await runs.put(
			"run_test",
			makeRun({ iteration: 8, limits: { max_iterations: 8 } }),
		);

		const result = await tickRun("run_test", ctx, {
			resolveDriver: () => makeDriver([]),
			siteUrl: "http://localhost:4321",
		});
		expect(result.run.status).toBe("failed");
		expect(result.run.error?.message).toMatch(/max_iterations/);
	});

	it("fails when max_tokens reached", async () => {
		const runs = new FakeStorage<Run>();
		const events = new FakeStorage<RunEvent>();
		const ctx = makeContext({ runs, runEvents: events });
		await runs.put(
			"run_test",
			makeRun({
				cost: { tokens_in: 1000, tokens_out: 1000, usd: 0, calls: 5 },
				limits: { max_iterations: 8, max_tokens: 1500 },
			}),
		);

		const result = await tickRun("run_test", ctx, {
			resolveDriver: () => makeDriver([]),
			siteUrl: "http://localhost:4321",
		});
		expect(result.run.status).toBe("failed");
		expect(result.run.error?.message).toMatch(/max_tokens/);
	});

	it("fails when max_usd reached", async () => {
		const runs = new FakeStorage<Run>();
		const events = new FakeStorage<RunEvent>();
		const ctx = makeContext({ runs, runEvents: events });
		await runs.put(
			"run_test",
			makeRun({
				cost: { tokens_in: 0, tokens_out: 0, usd: 1.0, calls: 0 },
				limits: { max_iterations: 8, max_usd: 0.5 },
			}),
		);

		const result = await tickRun("run_test", ctx, {
			resolveDriver: () => makeDriver([]),
			siteUrl: "http://localhost:4321",
		});
		expect(result.run.status).toBe("failed");
		expect(result.run.error?.message).toMatch(/max_usd/);
	});
});

describe("tickRun — terminal idempotency", () => {
	it.each(["completed", "cancelled", "failed"] as const)(
		"is a no-op when the run is already %s",
		async (status) => {
			const runs = new FakeStorage<Run>();
			const events = new FakeStorage<RunEvent>();
			const ctx = makeContext({ runs, runEvents: events });
			await runs.put("run_test", makeRun({ status }));

			const result = await tickRun("run_test", ctx, {
				resolveDriver: () => makeDriver([]),
				siteUrl: "http://localhost:4321",
			});

			expect(result.done).toBe(true);
			expect(result.scheduleNextTick).toBe(false);
			expect(result.run.status).toBe(status);
			expect(events.items.size).toBe(0);
		},
	);

	it("is a no-op (no schedule) when paused", async () => {
		const runs = new FakeStorage<Run>();
		const events = new FakeStorage<RunEvent>();
		const ctx = makeContext({ runs, runEvents: events });
		await runs.put("run_test", makeRun({ status: "paused" }));

		const result = await tickRun("run_test", ctx, {
			resolveDriver: () => makeDriver([]),
			siteUrl: "http://localhost:4321",
		});
		expect(result.done).toBe(false);
		expect(result.scheduleNextTick).toBe(false);
		expect(result.run.status).toBe("paused");
	});
});

describe("tickRun — driver missing", () => {
	it("fails the run when no driver is active", async () => {
		const runs = new FakeStorage<Run>();
		const events = new FakeStorage<RunEvent>();
		const ctx = makeContext({ runs, runEvents: events });
		await runs.put("run_test", makeRun());

		const result = await tickRun("run_test", ctx, {
			resolveDriver: () => null,
			siteUrl: "http://localhost:4321",
		});
		expect(result.run.status).toBe("failed");
		expect(result.run.error?.message).toMatch(/No active LLM driver/);
	});

	it("fails the run when the driver throws on chatCompletion", async () => {
		const runs = new FakeStorage<Run>();
		const events = new FakeStorage<RunEvent>();
		const ctx = makeContext({ runs, runEvents: events });
		await runs.put("run_test", makeRun());

		const driver = makeDriver([]);
		// Replace the driver's chatCompletion to throw on the first call.
		const handlers = driver.build({});
		handlers.chatCompletion = async () => {
			throw new Error("upstream 503");
		};
		driver.build = () => handlers;

		const result = await tickRun("run_test", ctx, {
			resolveDriver: () => driver,
			siteUrl: "http://localhost:4321",
		});
		expect(result.run.status).toBe("failed");
		expect(result.run.error?.message).toMatch(/upstream 503/);
	});
});

describe("tickRun — tool calls", () => {
	it("invokes a tool and schedules another tick", async () => {
		const runs = new FakeStorage<Run>();
		const events = new FakeStorage<RunEvent>();
		// Stub ctx.http for tools.invoke
		const fetchCalls: { url: string; init?: RequestInit }[] = [];
		const httpFetch = async (input: string | URL | Request, init?: RequestInit) => {
			fetchCalls.push({ url: String(input), init });
			return new Response(
				JSON.stringify({ data: { ok: true, output: { result: "tool ran" } } }),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		};
		const ctx = makeContext({
			runs,
			runEvents: events,
			http: { fetch: httpFetch as unknown as typeof fetch },
		});
		await runs.put("run_test", makeRun({ tools: [] }));

		const driver = makeDriver([toolCallResponse("content_get", { id: "post:1" })]);
		const result = await tickRun("run_test", ctx, {
			resolveDriver: () => driver,
			siteUrl: "http://localhost:4321",
		});

		expect(result.scheduleNextTick).toBe(true);
		expect(result.run.status).toBe("running");
		expect(fetchCalls).toHaveLength(1);
		expect(fetchCalls[0]?.url).toMatch(/tools\.invoke$/);
		const toolResultMsg = result.run.message_history.find((m) => m.role === "tool");
		expect(toolResultMsg).toBeDefined();
		expect(JSON.parse(toolResultMsg!.content as string)).toEqual({ result: "tool ran" });
	});

	it("records tool error in the message history without failing the run", async () => {
		const runs = new FakeStorage<Run>();
		const events = new FakeStorage<RunEvent>();
		const httpFetch = async () =>
			new Response(JSON.stringify({ data: { ok: false, error: "denied" } }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		const ctx = makeContext({
			runs,
			runEvents: events,
			http: { fetch: httpFetch as unknown as typeof fetch },
		});
		await runs.put("run_test", makeRun({ tools: [] }));

		const driver = makeDriver([toolCallResponse("content_publish", {})]);
		const result = await tickRun("run_test", ctx, {
			resolveDriver: () => driver,
			siteUrl: "http://localhost:4321",
		});

		expect(result.run.status).toBe("running");
		const toolResultMsg = result.run.message_history.find((m) => m.role === "tool");
		expect(JSON.parse(toolResultMsg!.content as string)).toEqual({ ok: false, error: "denied" });
	});
});
