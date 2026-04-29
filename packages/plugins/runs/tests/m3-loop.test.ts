/**
 * M3 — pause-and-approve flow through the loop.
 */

import type { ChatCompletionResponse } from "@emdash-cms/plugin-llm-router";
import { describe, expect, it } from "vitest";

import { tickRun } from "../src/loop.js";
import type { Run, RunEvent } from "../src/types.js";

import { FakeStorage, makeContext, makeDriver, toolCallResponse } from "./_helpers.js";

const NOW = "2026-04-29T00:00:00.000Z";

function makeRun(overrides: Partial<Run> = {}): Run {
	return {
		id: "run_test",
		agent_id: "writer",
		status: "queued",
		message_history: [{ role: "user", content: "do work" }],
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

function planResponse(planBody: string): ChatCompletionResponse {
	return {
		id: "x",
		model: "fake-model",
		created: 0,
		choices: [
			{
				index: 0,
				message: {
					role: "assistant",
					content: `Here's my plan:\n<plan>${planBody}</plan>`,
				},
				finish_reason: "stop",
			},
		],
		usage: { prompt_tokens: 5, completion_tokens: 30, total_tokens: 35 },
	};
}

describe("loop — plan-mode pause", () => {
	it("pauses on plan block and persists the parsed plan", async () => {
		const runs = new FakeStorage<Run>();
		const events = new FakeStorage<RunEvent>();
		const ctx = makeContext({ runs, runEvents: events });
		await runs.put("run_test", makeRun());

		const driver = makeDriver([planResponse('{"summary":"publish post","steps":[]}')]);
		const result = await tickRun("run_test", ctx, {
			resolveDriver: () => driver,
			siteUrl: "http://localhost:4321",
		});

		expect(result.run.status).toBe("awaiting_approval");
		expect(result.run.paused_for_human?.kind).toBe("plan-review");
		expect(result.run.approval_token).toMatch(/^apr_/);
		expect(result.scheduleNextTick).toBe(false);
		const plan = result.run.paused_for_human?.payload.plan as { summary: string };
		expect(plan.summary).toBe("publish post");

		const kinds = Array.from(events.items.values())
			.sort((a, b) => a.ordinal - b.ordinal)
			.map((e) => e.kind);
		expect(kinds).toContain("human-pause");
	});

	it("logs an error and continues when the plan block is malformed", async () => {
		const runs = new FakeStorage<Run>();
		const events = new FakeStorage<RunEvent>();
		const ctx = makeContext({ runs, runEvents: events });
		await runs.put("run_test", makeRun());

		// Plan block that is invalid JSON; the loop should log an error
		// and continue to completion (no tool calls, finish_reason stop).
		const driver = makeDriver([planResponse("{not json}")]);
		const result = await tickRun("run_test", ctx, {
			resolveDriver: () => driver,
			siteUrl: "http://localhost:4321",
		});

		expect(result.run.status).toBe("completed");
		const errEvents = Array.from(events.items.values()).filter((e) => e.kind === "error");
		expect(errEvents.length).toBeGreaterThan(0);
		expect((errEvents[0]?.payload as { message: string }).message).toMatch(/plan/i);
	});
});

describe("loop — tool-approval pause", () => {
	it("pauses when a tool returns paused_for_human and saves the originating tool_call", async () => {
		const runs = new FakeStorage<Run>();
		const events = new FakeStorage<RunEvent>();
		// tools.invoke returns a paused envelope.
		const httpFetch = async () =>
			new Response(
				JSON.stringify({
					data: {
						ok: false,
						paused_for_human: {
							kind: "tool-approval",
							tool: "content_publish",
							args: { collection: "posts", id: "p1" },
							reason: "publish requires approval",
						},
					},
				}),
				{ status: 200 },
			);
		const ctx = makeContext({
			runs,
			runEvents: events,
			http: { fetch: httpFetch as unknown as typeof fetch },
		});
		await runs.put("run_test", makeRun({ tools: [] }));

		const driver = makeDriver([toolCallResponse("content_publish", { collection: "posts", id: "p1" })]);
		const result = await tickRun("run_test", ctx, {
			resolveDriver: () => driver,
			siteUrl: "http://localhost:4321",
		});

		expect(result.run.status).toBe("awaiting_approval");
		expect(result.run.paused_for_human?.kind).toBe("tool-approval");
		const payload = result.run.paused_for_human?.payload as {
			tool: string;
			tool_call: { id: string };
		};
		expect(payload.tool).toBe("content_publish");
		expect(payload.tool_call.id).toBe("call_content_publish");
		expect(result.scheduleNextTick).toBe(false);
		expect(result.run.approval_token).toMatch(/^apr_/);

		// No synthetic tool message was added — the tool's result is
		// deferred until approval.
		const toolMsgs = result.run.message_history.filter((m) => m.role === "tool");
		expect(toolMsgs).toHaveLength(0);
	});
});
