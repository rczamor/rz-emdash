/**
 * M4 — SSE backfill + live notify.
 *
 * The harness calls `notifyRun(event)` after persisting each event;
 * subscribers (started by `streamRunEvents`) receive the live push.
 * Backfill replays events with `ordinal > since_ordinal` from
 * storage on subscribe so newcomers see history.
 */

import { describe, expect, it } from "vitest";

import { notifyRun, streamRunEvents } from "../src/stream.js";
import type { Run, RunEvent } from "../src/types.js";

import { FakeStorage, makeContext } from "./_helpers.js";

const NOW = "2026-04-29T00:00:00.000Z";

function mkEvent(runId: string, ordinal: number, kind: RunEvent["kind"] = "iteration-started"): RunEvent {
	return { id: `e${ordinal}`, run_id: runId, ordinal, kind, payload: {}, created_at: NOW };
}

function mkRun(status: Run["status"] = "running"): Run {
	return {
		id: "run_stream",
		agent_id: "writer",
		status,
		message_history: [],
		iteration: 0,
		limits: { max_iterations: 8 },
		cost: { tokens_in: 0, tokens_out: 0, usd: 0, calls: 0 },
		cancel_requested: false,
		model: "fake-model",
		driver_id: "fake",
		completion_input: { model: "fake-model", messages: [] },
		started_at: NOW,
		updated_at: NOW,
	};
}

async function readSseFrames(res: Response): Promise<RunEvent[]> {
	const text = await res.text();
	const frames = text.split("\n\n").filter(Boolean);
	const events: RunEvent[] = [];
	for (const frame of frames) {
		const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
		if (dataLine) events.push(JSON.parse(dataLine.slice(6)) as RunEvent);
	}
	return events;
}

describe("streamRunEvents — backfill", () => {
	it("backfills events with ordinal > since_ordinal", async () => {
		const runs = new FakeStorage<Run>();
		const events = new FakeStorage<RunEvent>();
		await runs.put("run_stream", mkRun("completed"));
		for (let i = 0; i < 5; i++) {
			await events.put(`e${i}`, mkEvent("run_stream", i));
		}
		// Seed a terminal event so the stream auto-closes.
		await events.put("e5", mkEvent("run_stream", 5, "run-completed"));
		const ctx = makeContext({ runs, runEvents: events });

		const res = streamRunEvents("run_stream", -1, ctx);
		const frames = await readSseFrames(res);
		expect(frames.map((e) => e.ordinal)).toEqual([0, 1, 2, 3, 4, 5]);
	});

	it("respects since_ordinal", async () => {
		const runs = new FakeStorage<Run>();
		const events = new FakeStorage<RunEvent>();
		await runs.put("run_stream", mkRun("completed"));
		for (let i = 0; i < 4; i++) await events.put(`e${i}`, mkEvent("run_stream", i));
		await events.put("e4", mkEvent("run_stream", 4, "run-completed"));
		const ctx = makeContext({ runs, runEvents: events });

		const res = streamRunEvents("run_stream", 1, ctx);
		const frames = await readSseFrames(res);
		expect(frames.map((e) => e.ordinal)).toEqual([2, 3, 4]);
	});

	it("returns content-type text/event-stream", () => {
		const runs = new FakeStorage<Run>();
		const events = new FakeStorage<RunEvent>();
		const ctx = makeContext({ runs, runEvents: events });
		const res = streamRunEvents("nope", -1, ctx);
		expect(res.headers.get("content-type")).toBe("text/event-stream");
	});
});

describe("streamRunEvents — live notify", () => {
	it("pushes events posted via notifyRun after subscription", async () => {
		const runs = new FakeStorage<Run>();
		const events = new FakeStorage<RunEvent>();
		await runs.put("run_stream", mkRun("running"));
		await events.put("e0", mkEvent("run_stream", 0));
		const ctx = makeContext({ runs, runEvents: events });

		const res = streamRunEvents("run_stream", -1, ctx);
		const reader = res.body!.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		const collected: RunEvent[] = [];

		const drain = async () => {
			while (true) {
				const { value, done } = await reader.read();
				if (done) return;
				buffer += decoder.decode(value, { stream: true });
				const frames = buffer.split("\n\n");
				buffer = frames.pop() ?? "";
				for (const frame of frames) {
					const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
					if (dataLine) collected.push(JSON.parse(dataLine.slice(6)) as RunEvent);
				}
			}
		};

		const drainPromise = drain();

		// Wait a tick for the start callback to backfill.
		await new Promise((r) => setTimeout(r, 10));

		// Push live events.
		await events.put("e1", mkEvent("run_stream", 1));
		notifyRun(mkEvent("run_stream", 1));

		await events.put("e2", mkEvent("run_stream", 2, "run-completed"));
		notifyRun(mkEvent("run_stream", 2, "run-completed"));

		await drainPromise;
		expect(collected.map((e) => e.ordinal)).toEqual([0, 1, 2]);
	});

	it("does not double-deliver an event seen during backfill", async () => {
		const runs = new FakeStorage<Run>();
		const events = new FakeStorage<RunEvent>();
		await runs.put("run_stream", mkRun("completed"));
		await events.put("e0", mkEvent("run_stream", 0));
		await events.put("e1", mkEvent("run_stream", 1, "run-completed"));
		const ctx = makeContext({ runs, runEvents: events });

		const res = streamRunEvents("run_stream", -1, ctx);
		// Race: notify the same event while subscribe/backfill is happening.
		notifyRun(mkEvent("run_stream", 0));
		const frames = await readSseFrames(res);
		const ordinals = frames.map((e) => e.ordinal);
		expect(ordinals.filter((o) => o === 0)).toHaveLength(1);
	});
});
