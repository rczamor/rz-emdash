import type { PluginContext } from "emdash";
import type {
	ChatCompletionInput,
	ChatCompletionResponse,
	Driver,
	DriverHandlers,
} from "@emdash-cms/plugin-llm-router";

import type { Run, RunEvent } from "../src/types.js";

/**
 * In-memory storage stub matching the runs plugin's `runs` and
 * `run_events` collection contracts. Sufficient for loop tests that
 * never touch a real database.
 */
export class FakeStorage<T> {
	readonly items = new Map<string, T>();

	async get(id: string): Promise<T | null> {
		return this.items.get(id) ?? null;
	}

	async put(id: string, data: T): Promise<void> {
		this.items.set(id, data);
	}

	async delete(id: string): Promise<boolean> {
		return this.items.delete(id);
	}

	async exists(id: string): Promise<boolean> {
		return this.items.has(id);
	}

	async getMany(ids: string[]): Promise<Array<T | null>> {
		return ids.map((id) => this.items.get(id) ?? null);
	}

	async putMany(items: Array<{ id: string; data: T }>): Promise<void> {
		for (const { id, data } of items) this.items.set(id, data);
	}

	async deleteMany(ids: string[]): Promise<number> {
		let n = 0;
		for (const id of ids) if (this.items.delete(id)) n++;
		return n;
	}

	async count(where?: Record<string, unknown>): Promise<number> {
		const all = Array.from(this.items.values()) as Array<Record<string, unknown>>;
		if (!where) return all.length;
		return all.filter((row) =>
			Object.entries(where).every(([k, v]) => (row as Record<string, unknown>)[k] === v),
		).length;
	}

	async query(opts?: {
		where?: Record<string, unknown>;
		orderBy?: Record<string, "asc" | "desc">;
		limit?: number;
		cursor?: string;
	}): Promise<{
		items: Array<{ id: string; data: T }>;
		cursor?: string;
		hasMore: boolean;
	}> {
		let rows = Array.from(this.items.entries()).map(([id, data]) => ({ id, data }));
		if (opts?.where) {
			rows = rows.filter((r) =>
				Object.entries(opts.where!).every(
					([k, v]) => (r.data as unknown as Record<string, unknown>)[k] === v,
				),
			);
		}
		if (opts?.orderBy) {
			const [[field, dir]] = Object.entries(opts.orderBy);
			rows.sort((a, b) => {
				const av = (a.data as unknown as Record<string, unknown>)[field];
				const bv = (b.data as unknown as Record<string, unknown>)[field];
				if (av === bv) return 0;
				const cmp = (av as number | string) < (bv as number | string) ? -1 : 1;
				return dir === "asc" ? cmp : -cmp;
			});
		}
		const limit = opts?.limit ?? rows.length;
		return { items: rows.slice(0, limit), hasMore: rows.length > limit };
	}
}

/**
 * Build a minimal PluginContext with the storage collections the runs
 * loop touches. `http` is intentionally absent unless a test needs it.
 */
export function makeContext(
	overrides: Partial<{
		runs: FakeStorage<Run>;
		runEvents: FakeStorage<RunEvent>;
		http: PluginContext["http"];
		log: PluginContext["log"];
	}> = {},
): PluginContext {
	const runs = overrides.runs ?? new FakeStorage<Run>();
	const runEvents = overrides.runEvents ?? new FakeStorage<RunEvent>();
	const log =
		overrides.log ??
		({
			debug: () => {},
			info: () => {},
			warn: () => {},
			error: () => {},
		} as unknown as PluginContext["log"]);
	return {
		plugin: { id: "runs", version: "0.0.1" },
		storage: { runs, run_events: runEvents } as unknown as PluginContext["storage"],
		kv: {
			get: async () => null,
			set: async () => {},
			delete: async () => false,
			list: async () => [],
		},
		log,
		site: { url: "http://localhost:4321" } as unknown as PluginContext["site"],
		url: (path: string) => `http://localhost:4321${path}`,
		http: overrides.http,
	} as PluginContext;
}

/**
 * Build a fake Driver whose `chatCompletion` returns whatever responses
 * are queued. `responses[i]` is returned on iteration `i+1`. Unqueued
 * iterations throw.
 */
export function makeDriver(
	responses: ChatCompletionResponse[],
	captureCalls: ChatCompletionInput[] = [],
): Driver {
	let i = 0;
	const handlers: DriverHandlers = {
		async chatCompletion(input) {
			captureCalls.push(input);
			const r = responses[i++];
			if (!r) throw new Error(`no response queued for iteration ${i}`);
			return r;
		},
		async embeddings() {
			throw new Error("not used");
		},
		async listModels() {
			return [];
		},
	};
	return {
		id: "fake",
		name: "Fake",
		defaults: { chatModel: "fake-model" },
		build: () => handlers,
		detect: () => true,
		configFromEnv: () => ({}),
	};
}

/** Build a minimal completion response with a finish_reason "stop". */
export function stopResponse(content: string): ChatCompletionResponse {
	return {
		id: "x",
		model: "fake-model",
		created: 0,
		choices: [
			{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" },
		],
		usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
	};
}

/** Build a response with a tool call. */
export function toolCallResponse(name: string, args: Record<string, unknown>): ChatCompletionResponse {
	return {
		id: "x",
		model: "fake-model",
		created: 0,
		choices: [
			{
				index: 0,
				message: {
					role: "assistant",
					content: null,
					tool_calls: [
						{
							id: `call_${name}`,
							type: "function",
							function: { name, arguments: JSON.stringify(args) },
						},
					],
				},
				finish_reason: "tool_calls",
			},
		],
		usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
	};
}
