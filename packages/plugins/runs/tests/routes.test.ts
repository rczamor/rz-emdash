import type { PluginContext } from "emdash";
import { describe, expect, it, vi } from "vitest";

// The sandbox-entry registers a scheduler:tick handler at module load.
// Mock the registry import so importing the plugin doesn't pollute the
// shared scheduler registry (and so we can assert on registration).
vi.mock("@emdash-cms/plugin-scheduler/registry", () => ({
	registerJobHandler: vi.fn(),
}));

// We also need to mock the llm-router driver registry so route handlers
// don't try to read a real driver from process.env.
vi.mock("@emdash-cms/plugin-llm-router", async () => {
	const actual = await vi.importActual<typeof import("@emdash-cms/plugin-llm-router")>(
		"@emdash-cms/plugin-llm-router",
	);
	return {
		...actual,
		resolveActiveDriver: () => ({
			id: "fake",
			name: "Fake",
			defaults: { chatModel: "fake-model" },
			build: () => ({
				chatCompletion: async () => ({
					id: "x",
					model: "fake-model",
					created: 0,
					choices: [
						{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" },
					],
				}),
				embeddings: async () => ({ data: [], model: "fake-model" }),
				listModels: async () => [],
			}),
			detect: () => true,
			configFromEnv: () => ({}),
		}),
	};
});

import plugin from "../src/sandbox-entry.js";
import type { Run, RunEvent } from "../src/types.js";

import { FakeStorage, makeContext } from "./_helpers.js";

function fakeRequest(url = "http://localhost:4321/_emdash/api/plugins/runs/x"): Request {
	return new Request(url, { method: "POST" });
}

describe("runs.start", () => {
	it("creates a run with a prompt", async () => {
		const runs = new FakeStorage<Run>();
		const events = new FakeStorage<RunEvent>();
		const httpFetch = vi.fn(
			async () => new Response(JSON.stringify({ data: { ok: true } }), { status: 200 }),
		);
		const ctx = makeContext({
			runs,
			runEvents: events,
			http: { fetch: httpFetch as unknown as typeof fetch },
		});

		const result = (await plugin.routes!["runs.start"]!.handler(
			{ input: { agent_id: "writer", prompt: "draft something" }, request: fakeRequest() },
			ctx,
		)) as { ok: boolean; run?: Run; error?: string };

		expect(result.ok).toBe(true);
		expect(result.run).toBeDefined();
		expect(result.run!.agent_id).toBe("writer");
		expect(result.run!.status).toBe("queued");
		expect(result.run!.message_history).toEqual([{ role: "user", content: "draft something" }]);
		expect(runs.items.size).toBe(1);
		// run-started event written
		expect(events.items.size).toBe(1);
		expect(Array.from(events.items.values())[0]?.kind).toBe("run-started");
		// Scheduler tick was scheduled
		expect(httpFetch).toHaveBeenCalled();
	});

	it("rejects when agent_id is missing", async () => {
		const ctx = makeContext();
		const result = (await plugin.routes!["runs.start"]!.handler(
			{ input: { prompt: "x" }, request: fakeRequest() },
			ctx,
		)) as { ok: boolean; error?: string };
		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/agent_id required/);
	});

	it("rejects when neither prompt nor messages provided", async () => {
		const ctx = makeContext();
		const result = (await plugin.routes!["runs.start"]!.handler(
			{ input: { agent_id: "writer" }, request: fakeRequest() },
			ctx,
		)) as { ok: boolean; error?: string };
		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/messages.*prompt/);
	});

	it("respects supplied limits", async () => {
		const runs = new FakeStorage<Run>();
		const events = new FakeStorage<RunEvent>();
		const ctx = makeContext({
			runs,
			runEvents: events,
			http: { fetch: vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch },
		});
		const result = (await plugin.routes!["runs.start"]!.handler(
			{
				input: {
					agent_id: "writer",
					prompt: "x",
					max_iterations: 3,
					max_tokens: 5000,
					max_usd: 0.25,
					max_wallclock_ms: 30000,
				},
				request: fakeRequest(),
			},
			ctx,
		)) as { ok: boolean; run?: Run };
		expect(result.run!.limits).toEqual({
			max_iterations: 3,
			max_tokens: 5000,
			max_usd: 0.25,
			max_wallclock_ms: 30000,
		});
	});
});

describe("runs.cancel", () => {
	it("sets cancel_requested on a running run", async () => {
		const runs = new FakeStorage<Run>();
		const events = new FakeStorage<RunEvent>();
		const ctx = makeContext({
			runs,
			runEvents: events,
			http: { fetch: vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch },
		});
		await runs.put("run_1", makeRun({ status: "running" }));
		const result = (await plugin.routes!["runs.cancel"]!.handler(
			{ input: { id: "run_1" }, request: fakeRequest() },
			ctx,
		)) as { ok: boolean; run?: Run };
		expect(result.ok).toBe(true);
		expect(result.run!.cancel_requested).toBe(true);
	});

	it("rejects cancellation on a terminal run", async () => {
		const runs = new FakeStorage<Run>();
		const events = new FakeStorage<RunEvent>();
		const ctx = makeContext({ runs, runEvents: events });
		await runs.put("run_1", makeRun({ status: "completed" }));
		const result = (await plugin.routes!["runs.cancel"]!.handler(
			{ input: { id: "run_1" }, request: fakeRequest() },
			ctx,
		)) as { ok: boolean; error?: string };
		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/terminal/);
	});

	it("returns Not found when the run does not exist", async () => {
		const ctx = makeContext();
		const result = (await plugin.routes!["runs.cancel"]!.handler(
			{ input: { id: "missing" }, request: fakeRequest() },
			ctx,
		)) as { ok: boolean; error?: string };
		expect(result.ok).toBe(false);
		expect(result.error).toBe("Not found");
	});
});

describe("runs.pause and runs.resume", () => {
	it("pauses then resumes a running run", async () => {
		const runs = new FakeStorage<Run>();
		const events = new FakeStorage<RunEvent>();
		const ctx = makeContext({
			runs,
			runEvents: events,
			http: { fetch: vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch },
		});
		await runs.put("run_1", makeRun({ status: "running" }));

		const pauseResult = (await plugin.routes!["runs.pause"]!.handler(
			{ input: { id: "run_1", reason: "operator break" }, request: fakeRequest() },
			ctx,
		)) as { ok: boolean; run?: Run };
		expect(pauseResult.run!.status).toBe("paused");
		expect(pauseResult.run!.paused_for_human?.kind).toBe("operator");

		const resumeResult = (await plugin.routes!["runs.resume"]!.handler(
			{ input: { id: "run_1" }, request: fakeRequest() },
			ctx,
		)) as { ok: boolean; run?: Run };
		expect(resumeResult.run!.status).toBe("queued");
		expect(resumeResult.run!.paused_for_human).toBeUndefined();
	});

	it("rejects resume when the run is not paused", async () => {
		const runs = new FakeStorage<Run>();
		const events = new FakeStorage<RunEvent>();
		const ctx = makeContext({ runs, runEvents: events });
		await runs.put("run_1", makeRun({ status: "running" }));
		const result = (await plugin.routes!["runs.resume"]!.handler(
			{ input: { id: "run_1" }, request: fakeRequest() },
			ctx,
		)) as { ok: boolean; error?: string };
		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/not paused/);
	});
});

describe("runs.list and runs.get", () => {
	it("lists runs filtered by agent_id", async () => {
		const runs = new FakeStorage<Run>();
		const events = new FakeStorage<RunEvent>();
		const ctx = makeContext({ runs, runEvents: events });
		await runs.put("a1", makeRun({ id: "a1", agent_id: "writer" }));
		await runs.put("a2", makeRun({ id: "a2", agent_id: "writer" }));
		await runs.put("b1", makeRun({ id: "b1", agent_id: "editor" }));

		const result = (await plugin.routes!["runs.list"]!.handler(
			{
				input: null,
				request: new Request("http://x/?agent_id=writer", { method: "GET" }),
			},
			ctx,
		)) as { ok: boolean; runs: Run[] };
		expect(result.runs).toHaveLength(2);
		expect(result.runs.every((r) => r.agent_id === "writer")).toBe(true);
	});

	it("returns the run plus its events on runs.get", async () => {
		const runs = new FakeStorage<Run>();
		const events = new FakeStorage<RunEvent>();
		const ctx = makeContext({ runs, runEvents: events });
		await runs.put("r1", makeRun({ id: "r1" }));
		await events.put("e1", {
			id: "e1",
			run_id: "r1",
			ordinal: 0,
			kind: "run-started",
			payload: {},
			created_at: "2026-04-29T00:00:00Z",
		});
		const result = (await plugin.routes!["runs.get"]!.handler(
			{ input: null, request: new Request("http://x/?id=r1", { method: "GET" }) },
			ctx,
		)) as { ok: boolean; run: Run; events: RunEvent[] };
		expect(result.run.id).toBe("r1");
		expect(result.events).toHaveLength(1);
	});

	it("runs.events filters by since_ordinal", async () => {
		const runs = new FakeStorage<Run>();
		const events = new FakeStorage<RunEvent>();
		const ctx = makeContext({ runs, runEvents: events });
		for (let i = 0; i < 5; i++) {
			await events.put(`e${i}`, {
				id: `e${i}`,
				run_id: "r1",
				ordinal: i,
				kind: "iteration-started",
				payload: {},
				created_at: "2026-04-29T00:00:00Z",
			});
		}
		const result = (await plugin.routes!["runs.events"]!.handler(
			{
				input: null,
				request: new Request("http://x/?run_id=r1&since_ordinal=2", { method: "GET" }),
			},
			ctx,
		)) as { ok: boolean; events: RunEvent[] };
		expect(result.events.map((e) => e.ordinal)).toEqual([3, 4]);
	});
});

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
