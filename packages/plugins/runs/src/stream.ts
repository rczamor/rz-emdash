/**
 * Server-Sent Events stream of a run's event log.
 *
 * `streamRunEvents` returns a Web `Response` whose body is an
 * `EventSource`-compatible `text/event-stream`. Initial events are
 * backfilled from storage (since `since_ordinal`); subsequent events
 * are pushed via the per-run subscriber list when the loop persists
 * them. The connection closes automatically when the run reaches a
 * terminal state.
 *
 * Cloudflare Workers caveat: subscribers only see events from the
 * same isolate. Cross-isolate broadcast requires a Durable Object,
 * deferred. Operators on Cloudflare see live updates only when their
 * GET `/runs.stream` request lands on the same isolate as the
 * `runs:tick` request. The polling fallback (`runs.events?since_ordinal=`)
 * remains correct in all cases.
 */

import type { PluginContext } from "emdash";

import type { Run, RunEvent } from "./types.js";

/**
 * Per-isolate subscriber registry. Each running stream pushes a
 * notify callback here keyed by run_id; the loop calls `notifyRun`
 * after every persisted event. Stored on globalThis so multiple
 * imports of this module share the registry.
 */
const STREAM_REGISTRY_KEY = Symbol.for("emdash.pluginRuns.streamRegistry");

interface StreamRegistryState {
	subscribers: Map<string, Set<(event: RunEvent) => void>>;
}

type StreamRegistryGlobal = typeof globalThis & {
	[STREAM_REGISTRY_KEY]?: StreamRegistryState;
};

function getRegistry(): StreamRegistryState {
	const g = globalThis as StreamRegistryGlobal;
	g[STREAM_REGISTRY_KEY] ??= { subscribers: new Map() };
	return g[STREAM_REGISTRY_KEY];
}

/** Called by the loop after persisting any RunEvent. Fans out to active streams. */
export function notifyRun(event: RunEvent): void {
	const reg = getRegistry();
	const subs = reg.subscribers.get(event.run_id);
	if (!subs) return;
	for (const cb of subs) {
		try {
			cb(event);
		} catch {
			// A subscriber callback throwing should not poison the loop.
			// The stream will detect the closed controller on its next push.
		}
	}
}

function subscribe(runId: string, cb: (event: RunEvent) => void): () => void {
	const reg = getRegistry();
	let subs = reg.subscribers.get(runId);
	if (!subs) {
		subs = new Set();
		reg.subscribers.set(runId, subs);
	}
	subs.add(cb);
	return () => {
		subs!.delete(cb);
		if (subs!.size === 0) reg.subscribers.delete(runId);
	};
}

const TERMINAL_KINDS: ReadonlySet<RunEvent["kind"]> = new Set([
	"run-completed",
	"run-failed",
	"run-cancelled",
]);

/** Encode a RunEvent as an SSE message frame. */
function encodeSseFrame(event: RunEvent): string {
	const data = JSON.stringify(event);
	return `event: ${event.kind}\nid: ${event.ordinal}\ndata: ${data}\n\n`;
}

/**
 * Open an SSE connection that backfills events since `since_ordinal`
 * and then streams new events live. Closes automatically when a
 * terminal event is observed.
 */
export function streamRunEvents(
	runId: string,
	sinceOrdinal: number,
	ctx: PluginContext,
): Response {
	const encoder = new TextEncoder();
	let unsubscribe: (() => void) | undefined;

	let closed = false;
	const body = new ReadableStream<Uint8Array>({
		async start(controller) {
			// Subscribe BEFORE backfilling so we don't miss events that
			// arrive between the backfill query and the subscription.
			const seen = new Set<number>();
			const closeStream = () => {
				if (closed) return;
				closed = true;
				unsubscribe?.();
				try {
					controller.close();
				} catch {
					// Already closed by client.
				}
			};

			const enqueue = (event: RunEvent) => {
				if (closed) return;
				if (seen.has(event.ordinal)) return;
				seen.add(event.ordinal);
				try {
					controller.enqueue(encoder.encode(encodeSseFrame(event)));
				} catch {
					closeStream();
					return;
				}
				if (TERMINAL_KINDS.has(event.kind)) {
					closeStream();
				}
			};

			unsubscribe = subscribe(runId, enqueue);

			// Backfill events that already happened before subscription.
			const events = (ctx.storage as unknown as {
				run_events: {
					query: (opts: {
						where?: Record<string, unknown>;
						orderBy?: Record<string, "asc" | "desc">;
						limit?: number;
					}) => Promise<{ items: Array<{ data: RunEvent }> }>;
				};
			}).run_events;
			const past = await events.query({
				where: { run_id: runId },
				orderBy: { ordinal: "asc" },
				limit: 1000,
			});
			for (const item of past.items) {
				if (item.data.ordinal > sinceOrdinal) enqueue(item.data);
				if (closed) return;
			}

			// If the run is already terminal at subscribe time, close out
			// (in case backfill didn't include the terminal event).
			const run = (await (ctx.storage as unknown as {
				runs: { get: (id: string) => Promise<Run | null> };
			}).runs.get(runId)) as Run | null;
			if (run && (run.status === "completed" || run.status === "failed" || run.status === "cancelled")) {
				closeStream();
			}
		},
		cancel() {
			closed = true;
			unsubscribe?.();
		},
	});

	return new Response(body, {
		status: 200,
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache, no-store, must-revalidate",
			Connection: "keep-alive",
			"X-Accel-Buffering": "no",
		},
	});
}
