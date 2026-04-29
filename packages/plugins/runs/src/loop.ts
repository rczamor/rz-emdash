/**
 * Checkpointed harness loop.
 *
 * `tickRun` is the per-iteration step. It loads a Run from storage,
 * checks limits and cancellation, dispatches one driver call (plus
 * any tool calls the response asked for), persists the updated Run +
 * appends events, and decides whether another tick is needed.
 *
 * The loop is **idempotent on terminal states** — if a tick fires on
 * a run that's already completed, cancelled, or failed, it returns
 * `{ done: true, scheduleNextTick: false }` without mutating state.
 * That matters for the scheduler retry path.
 *
 * The driver is resolved once per tick via the llm-router driver
 * registry. Tool invocations go through internal RPC to the tools
 * plugin so the per-agent allowlist + audit log are honored exactly
 * the same way they would be from any other caller.
 */

import type { PluginContext } from "emdash";
import type {
	ChatCompletionResponse,
	ChatMessage,
	ChatToolCall,
	Driver,
	DriverHandlers,
} from "@emdash-cms/plugin-llm-router";

import { newApprovalToken } from "./approval.js";
import { extractPlanBlock, parsePlan } from "./plan.js";
import { notifyRun } from "./stream.js";
import type { Run, RunEvent, RunEventKind } from "./types.js";

const NOW = (): string => new Date().toISOString();

type RunsStorage = {
	runs: { get: (id: string) => Promise<unknown>; put: (id: string, data: Run) => Promise<void> };
	run_events: { put: (id: string, data: RunEvent) => Promise<void> };
};

function getRunsStorage(ctx: PluginContext): RunsStorage {
	return ctx.storage as unknown as RunsStorage;
}

export interface TickResult {
	done: boolean;
	scheduleNextTick: boolean;
	run: Run;
}

export interface LoopDeps {
	resolveDriver: () => Driver | null;
	siteUrl: string;
}

/**
 * Generate a stable id for a run event. Format mirrors other plugins
 * (`emb_`, `inv_`, `tsk_`) so logs are scannable.
 */
function newEventId(): string {
	return `evt_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

async function appendEvent(
	ctx: PluginContext,
	run: Run,
	kind: RunEventKind,
	payload: Record<string, unknown>,
	ordinal: number,
): Promise<void> {
	const event: RunEvent = {
		id: newEventId(),
		run_id: run.id,
		ordinal,
		kind,
		payload,
		created_at: NOW(),
	};
	await getRunsStorage(ctx).run_events.put(event.id, event);
	// M4 — fan out to any active SSE subscribers in this isolate.
	notifyRun(event);
}

/**
 * Walk the run_events log to find the next ordinal. Cheap on small
 * runs; for very long runs we'd cache the last ordinal on the Run row.
 * For M1 we keep it simple — runs typically <50 events.
 */
async function nextOrdinal(ctx: PluginContext, run: Run): Promise<number> {
	const events = (ctx.storage as unknown as {
		run_events: {
			query: (opts: {
				where?: Record<string, unknown>;
				orderBy?: Record<string, "asc" | "desc">;
				limit?: number;
			}) => Promise<{ items: Array<{ data: RunEvent }> }>;
		};
	}).run_events;
	const result = await events.query({
		where: { run_id: run.id },
		orderBy: { ordinal: "desc" },
		limit: 1,
	});
	const last = result.items[0]?.data;
	return (last?.ordinal ?? -1) + 1;
}

function isTerminal(status: Run["status"]): boolean {
	return status === "completed" || status === "failed" || status === "cancelled";
}

function withinLimits(
	run: Run,
	startedAtMs: number,
): { ok: true } | { ok: false; reason: string; payload: Record<string, unknown> } {
	if (run.iteration >= run.limits.max_iterations) {
		return {
			ok: false,
			reason: "max_iterations",
			payload: { limit: run.limits.max_iterations, iteration: run.iteration },
		};
	}
	if (run.limits.max_tokens !== undefined) {
		const total = run.cost.tokens_in + run.cost.tokens_out;
		if (total >= run.limits.max_tokens) {
			return { ok: false, reason: "max_tokens", payload: { limit: run.limits.max_tokens, used: total } };
		}
	}
	if (run.limits.max_usd !== undefined && run.cost.usd >= run.limits.max_usd) {
		return { ok: false, reason: "max_usd", payload: { limit: run.limits.max_usd, used: run.cost.usd } };
	}
	if (run.limits.max_wallclock_ms !== undefined) {
		const elapsed = Date.now() - startedAtMs;
		if (elapsed >= run.limits.max_wallclock_ms) {
			return {
				ok: false,
				reason: "max_wallclock",
				payload: { limit: run.limits.max_wallclock_ms, elapsed },
			};
		}
	}
	return { ok: true };
}

/**
 * Estimate USD cost from a usage record. We do not have a per-model
 * pricing table in M1, so this is a heuristic ($0.50 / 1M input,
 * $1.50 / 1M output — approximate Haiku 4.5 rates). M5's cost
 * dashboard will replace this with a per-model lookup.
 */
function estimateUsd(usage: { prompt_tokens: number; completion_tokens: number }): number {
	const inputCost = (usage.prompt_tokens / 1_000_000) * 0.5;
	const outputCost = (usage.completion_tokens / 1_000_000) * 1.5;
	return inputCost + outputCost;
}

type ToolPause = { kind: string; tool: string; args?: Record<string, unknown>; reason?: string };
type InvokeOutcome =
	| { kind: "ok"; tool_call_id: string; content: string; output: unknown }
	| { kind: "error"; tool_call_id: string; content: string; error: string }
	| { kind: "paused"; tool_call_id: string; pause: ToolPause }
	| { kind: "subrun"; tool_call_id: string; sub_run_id: string };

async function invokeTool(
	toolCall: ChatToolCall,
	run: Run,
	siteUrl: string,
	ctx: PluginContext,
	forceExecute = false,
): Promise<InvokeOutcome> {
	const start = Date.now();

	if (!ctx.http) {
		const error = "network:fetch capability missing";
		await persistToolCallEvent(ctx, run, toolCall, { error, duration_ms: 0 });
		return {
			kind: "error",
			tool_call_id: toolCall.id,
			content: JSON.stringify({ ok: false, error }),
			error,
		};
	}

	let parsed: Record<string, unknown> = {};
	try {
		parsed = JSON.parse(toolCall.function.arguments || "{}") as Record<string, unknown>;
	} catch (err) {
		const error = `Failed to parse tool arguments: ${err instanceof Error ? err.message : String(err)}`;
		await persistToolCallEvent(ctx, run, toolCall, { error, duration_ms: Date.now() - start });
		return {
			kind: "error",
			tool_call_id: toolCall.id,
			content: JSON.stringify({ ok: false, error }),
			error,
		};
	}

	const invokeArgs = forceExecute ? { ...parsed, _force_execute: true } : parsed;

	let output: unknown;
	let error: string | undefined;
	let pause: ToolPause | undefined;
	try {
		const res = await ctx.http.fetch(`${siteUrl}/_emdash/api/plugins/tools/tools.invoke`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				name: toolCall.function.name,
				arguments: invokeArgs,
				taskId: run.task_id,
				agentId: run.agent_id,
			}),
		});
		if (!res.ok) {
			error = `tools.invoke returned ${res.status}`;
		} else {
			const json = (await res.json()) as {
				data?: {
					ok?: boolean;
					output?: unknown;
					error?: string;
					paused_for_human?: ToolPause;
					paused_for_subrun?: { run_id: string };
				};
			};
			const data = json.data ?? {};
			if (data.paused_for_human) {
				pause = data.paused_for_human;
			} else if ((data as { paused_for_subrun?: { run_id: string } }).paused_for_subrun?.run_id) {
				const subRunId = (data as { paused_for_subrun: { run_id: string } }).paused_for_subrun.run_id;
				const durationMs = Date.now() - start;
				await persistToolCallEvent(ctx, run, toolCall, {
					output: { sub_run_id: subRunId },
					duration_ms: durationMs,
				});
				return { kind: "subrun", tool_call_id: toolCall.id, sub_run_id: subRunId };
			} else if (data.ok === false) {
				error = data.error ?? "Tool returned ok:false";
			} else {
				// agent_dispatch returns { ok: true, paused_for_subrun, ... }
				// in the tool body — runs.invoke wraps in `data.output` after
				// the tool's own ok-shape resolution, so paused_for_subrun
				// might also surface inside output. Detect that path too.
				if (
					typeof data.output === "object" &&
					data.output !== null &&
					"paused_for_subrun" in data.output
				) {
					const sub = (data.output as { paused_for_subrun: { run_id?: string } })
						.paused_for_subrun;
					if (sub?.run_id) {
						const durationMs = Date.now() - start;
						await persistToolCallEvent(ctx, run, toolCall, {
							output: { sub_run_id: sub.run_id },
							duration_ms: durationMs,
						});
						return { kind: "subrun", tool_call_id: toolCall.id, sub_run_id: sub.run_id };
					}
				}
				output = data.output;
			}
		}
	} catch (err) {
		error = err instanceof Error ? err.message : String(err);
	}

	const durationMs = Date.now() - start;
	await persistToolCallEvent(ctx, run, toolCall, {
		output,
		error,
		paused: pause,
		duration_ms: durationMs,
	});

	if (pause) {
		return { kind: "paused", tool_call_id: toolCall.id, pause };
	}
	if (error) {
		return {
			kind: "error",
			tool_call_id: toolCall.id,
			content: JSON.stringify({ ok: false, error }),
			error,
		};
	}
	return {
		kind: "ok",
		tool_call_id: toolCall.id,
		content: JSON.stringify(output ?? null),
		output,
	};
}

async function persistToolCallEvent(
	ctx: PluginContext,
	run: Run,
	toolCall: ChatToolCall,
	extra: {
		output?: unknown;
		error?: string;
		paused?: ToolPause;
		duration_ms: number;
	},
): Promise<void> {
	const ordinal = await nextOrdinal(ctx, run);
	await appendEvent(
		ctx,
		run,
		"tool-call",
		{
			tool_call_id: toolCall.id,
			name: toolCall.function.name,
			arguments: toolCall.function.arguments,
			output: extra.output,
			error: extra.error,
			paused: extra.paused,
			duration_ms: extra.duration_ms,
		},
		ordinal,
	);
}

/**
 * Advance one iteration of the run. Returns the updated Run and
 * whether another tick should be scheduled.
 *
 * Persistence happens at three points:
 *   1. After the limit/cancel check (status transition to terminal),
 *   2. After the LLM call (message_history + cost),
 *   3. After every tool call.
 *
 * If the process dies between (1) and (2), `runs.resume` re-enters
 * here with the same iteration; the LLM call is re-issued. That is
 * the cost of statelessness for Workers compatibility — at-least-once
 * semantics on iterations. Tool calls themselves use the audit log
 * for idempotency where it matters.
 */
export async function tickRun(
	runId: string,
	ctx: PluginContext,
	deps: LoopDeps,
): Promise<TickResult> {
	const storage = getRunsStorage(ctx);
	const stored = (await storage.runs.get(runId)) as Run | null;
	if (!stored) {
		throw new Error(`Run not found: ${runId}`);
	}
	let run: Run = stored;

	if (isTerminal(run.status)) {
		return { done: true, scheduleNextTick: false, run };
	}
	if (run.status === "awaiting_approval" || run.status === "paused") {
		return { done: false, scheduleNextTick: false, run };
	}

	if (run.cancel_requested) {
		run = await finalize(ctx, run, "cancelled");
		const ordinal = await nextOrdinal(ctx, run);
		await appendEvent(ctx, run, "run-cancelled", { reason: "cancel_requested" }, ordinal);
		return { done: true, scheduleNextTick: false, run };
	}

	const startedAtMs = Date.parse(run.started_at);
	const limit = withinLimits(run, startedAtMs);
	if (!limit.ok) {
		const ordinal = await nextOrdinal(ctx, run);
		await appendEvent(ctx, run, "limit-hit", { reason: limit.reason, ...limit.payload }, ordinal);
		run = await finalize(ctx, run, "failed", { message: `limit: ${limit.reason}`, iteration: run.iteration });
		return { done: true, scheduleNextTick: false, run };
	}

	const driver = deps.resolveDriver();
	if (!driver) {
		const ordinal = await nextOrdinal(ctx, run);
		await appendEvent(ctx, run, "error", { message: "No active LLM driver" }, ordinal);
		run = await finalize(ctx, run, "failed", { message: "No active LLM driver", iteration: run.iteration });
		return { done: true, scheduleNextTick: false, run };
	}

	// Mark the run running and bump iteration.
	run.status = "running";
	run.iteration += 1;
	run.updated_at = NOW();
	await storage.runs.put(run.id, run);

	const iterationOrdinal = await nextOrdinal(ctx, run);
	await appendEvent(ctx, run, "iteration-started", { iteration: run.iteration }, iterationOrdinal);

	// Build driver handlers and call.
	let handlers: DriverHandlers;
	try {
		handlers = driver.build(driver.configFromEnv(process.env as Record<string, string | undefined>));
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		const ordinal = await nextOrdinal(ctx, run);
		await appendEvent(ctx, run, "error", { message: `Driver build failed: ${msg}` }, ordinal);
		run = await finalize(ctx, run, "failed", { message: msg, iteration: run.iteration });
		return { done: true, scheduleNextTick: false, run };
	}

	const callStart = Date.now();
	let response: ChatCompletionResponse;
	try {
		response = await handlers.chatCompletion(
			{ ...run.completion_input, messages: run.message_history, tools: run.tools },
			globalThis.fetch,
		);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		const ordinal = await nextOrdinal(ctx, run);
		await appendEvent(ctx, run, "error", { message: msg, iteration: run.iteration }, ordinal);
		run = await finalize(ctx, run, "failed", { message: msg, iteration: run.iteration });
		return { done: true, scheduleNextTick: false, run };
	}
	const callDuration = Date.now() - callStart;

	const choice = response.choices[0];
	if (!choice) {
		const ordinal = await nextOrdinal(ctx, run);
		await appendEvent(ctx, run, "error", { message: "Empty completion response" }, ordinal);
		run = await finalize(ctx, run, "failed", {
			message: "Empty completion response",
			iteration: run.iteration,
		});
		return { done: true, scheduleNextTick: false, run };
	}

	const assistantMsg = choice.message;
	run.message_history = [...run.message_history, assistantMsg];

	if (response.usage) {
		const usd = estimateUsd(response.usage);
		run.cost = {
			tokens_in: run.cost.tokens_in + response.usage.prompt_tokens,
			tokens_out: run.cost.tokens_out + response.usage.completion_tokens,
			usd: run.cost.usd + usd,
			calls: run.cost.calls + 1,
		};
	}
	run.updated_at = NOW();
	await storage.runs.put(run.id, run);

	const llmOrdinal = await nextOrdinal(ctx, run);
	await appendEvent(ctx, run, "llm-call", {
		model: run.model,
		driver: driver.id,
		usage: response.usage,
		finish_reason: choice.finish_reason,
		tool_calls: assistantMsg.tool_calls?.length ?? 0,
		duration_ms: callDuration,
	}, llmOrdinal);

	// M3 — plan block detection. If the assistant emitted a <plan>
	// block, persist the parsed Plan and pause for human approval.
	// The model has already completed its turn; the next tick will
	// pick up post-resume.
	const planBlock = extractPlanBlock(assistantMsg.content);
	if (planBlock) {
		const parsed = parsePlan(planBlock);
		if (parsed.ok) {
			run.status = "awaiting_approval";
			run.paused_for_human = {
				kind: "plan-review",
				payload: { plan: parsed.plan as unknown as Record<string, unknown> },
				created_at: NOW(),
			};
			run.approval_token = newApprovalToken();
			run.updated_at = NOW();
			await storage.runs.put(run.id, run);
			const ordinal = await nextOrdinal(ctx, run);
			await appendEvent(ctx, run, "human-pause", {
				kind: "plan-review",
				plan: parsed.plan,
			}, ordinal);
			return { done: false, scheduleNextTick: false, run };
		}
		// Malformed plan block — log and proceed; the model will retry.
		const ordinal = await nextOrdinal(ctx, run);
		await appendEvent(ctx, run, "error", {
			message: `Failed to parse plan block: ${parsed.error}`,
		}, ordinal);
	}

	// Tool execution — all tool calls of this iteration in this tick.
	const toolCalls = assistantMsg.tool_calls ?? [];
	for (const tc of toolCalls) {
		const result = await invokeTool(tc, run, deps.siteUrl, ctx);
		if (result.kind === "paused") {
			run.status = "awaiting_approval";
			run.paused_for_human = {
				kind: "tool-approval",
				payload: {
					tool: result.pause.tool,
					tool_call: tc as unknown as Record<string, unknown>,
					reason: result.pause.reason ?? "Tool requires approval",
				},
				created_at: NOW(),
			};
			run.approval_token = newApprovalToken();
			run.updated_at = NOW();
			await storage.runs.put(run.id, run);
			const ordinal = await nextOrdinal(ctx, run);
			await appendEvent(ctx, run, "human-pause", {
				kind: "tool-approval",
				tool: result.pause.tool,
				reason: result.pause.reason,
			}, ordinal);
			return { done: false, scheduleNextTick: false, run };
		}
		if (result.kind === "subrun") {
			// M7 — parent pauses awaiting the sub-run. The auto-routine
			// `run:completed → resume parent` lands in M7's auto-routines
			// scaffolding; until that ships, an operator can resume
			// manually with the sub-run's final output.
			run.status = "paused";
			run.paused_for_human = {
				kind: "awaiting-subrun",
				payload: {
					tool_call: tc as unknown as Record<string, unknown>,
					sub_run_id: result.sub_run_id,
				},
				created_at: NOW(),
			};
			run.updated_at = NOW();
			await storage.runs.put(run.id, run);
			const ordinal = await nextOrdinal(ctx, run);
			await appendEvent(ctx, run, "human-pause", {
				kind: "awaiting-subrun",
				sub_run_id: result.sub_run_id,
			}, ordinal);
			return { done: false, scheduleNextTick: false, run };
		}
		const toolMsg: ChatMessage = {
			role: "tool",
			tool_call_id: result.tool_call_id,
			content: result.content,
		};
		run.message_history = [...run.message_history, toolMsg];
		run.updated_at = NOW();
		await storage.runs.put(run.id, run);
	}

	// If the model returned a normal stop and no tool calls, we're done.
	if (toolCalls.length === 0) {
		run = await finalize(ctx, run, "completed");
		const ordinal = await nextOrdinal(ctx, run);
		await appendEvent(ctx, run, "run-completed", {
			iterations: run.iteration,
			cost: run.cost,
		}, ordinal);
		return { done: true, scheduleNextTick: false, run };
	}

	// Tool calls happened; another iteration is needed.
	return { done: false, scheduleNextTick: true, run };
}

async function finalize(
	ctx: PluginContext,
	run: Run,
	status: "completed" | "failed" | "cancelled",
	error?: { message: string; iteration: number },
): Promise<Run> {
	run.status = status;
	run.completed_at = NOW();
	run.updated_at = run.completed_at;
	if (error) run.error = error;
	await getRunsStorage(ctx).runs.put(run.id, run);
	return run;
}
