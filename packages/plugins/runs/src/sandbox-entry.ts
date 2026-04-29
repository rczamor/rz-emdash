/**
 * Runs — runtime entrypoint.
 *
 * Routes:
 *   POST  runs.start       create a Run, schedule first tick
 *   GET   runs.get?id=     full Run state + recent events
 *   GET   runs.list        list runs by agent_id / task_id / status
 *   POST  runs.cancel      mark cancel_requested; loop checks each tick
 *   POST  runs.pause       operator-initiated pause
 *   POST  runs.resume      lift a pause / approve a human-pause
 *   POST  runs.tick        invoked internally by the scheduler runs:tick handler
 *   GET   runs.events?run_id=&since_ordinal=   tail the event log
 *
 * The loop itself lives in `loop.ts`. This file owns the route shapes,
 * the scheduler hand-off, and the run-create defaults.
 */

import { definePlugin } from "emdash";
import type { PluginContext } from "emdash";
import { resolveActiveDriver } from "@emdash-cms/plugin-llm-router";
import type { ChatMessage, Driver, ToolSpec } from "@emdash-cms/plugin-llm-router";
import { registerJobHandler } from "@emdash-cms/plugin-scheduler/registry";

import { registerDefaultValidators } from "./default-validators.js";
import { tickRun } from "./loop.js";
import type { Run, RunEvent, StartRunInput } from "./types.js";
import { aggregateUsage, type UsageGroup, type UsagePeriod } from "./usage-summary.js";
import { runValidators } from "./validators.js";

// Register built-in validators (currently: seo). Idempotent.
registerDefaultValidators();

const NOW = (): string => new Date().toISOString();
const TRAILING_SLASH_RE = /\/$/;

const DEFAULT_MAX_ITERATIONS = 16;
const DEFAULT_MAX_WALLCLOCK_MS = 10 * 60 * 1000;

// Register the scheduler custom handler at module load. The scheduler
// custom-handler registry is on globalThis, so this works in both
// trusted and sandboxed isolates without coordination.
registerJobHandler("runs:tick", async (data, ctx) => {
	const runId = (data as { runId?: string } | undefined)?.runId;
	if (!runId) {
		ctx.log.warn("runs:tick fired without runId");
		return;
	}
	await tickAndMaybeReschedule(runId, ctx);
});

interface RouteCtx {
	input: unknown;
	request: Request;
}

function getQueryParam(routeCtx: RouteCtx, key: string): string | undefined {
	return new URL(routeCtx.request.url).searchParams.get(key) ?? undefined;
}

function siteUrl(ctx: PluginContext): string {
	return ((ctx.site as { url?: string } | undefined)?.url ?? "http://localhost:4321").replace(
		TRAILING_SLASH_RE,
		"",
	);
}

function newRunId(): string {
	return `run_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function buildInitialMessages(input: StartRunInput): ChatMessage[] {
	if (input.messages && input.messages.length > 0) return [...input.messages];
	if (input.prompt) return [{ role: "user", content: input.prompt }];
	throw new Error("runs.start requires either `messages` or `prompt`");
}

async function scheduleNextTick(runId: string, ctx: PluginContext): Promise<void> {
	if (!ctx.http) {
		ctx.log.error("runs.scheduleNextTick: network:fetch capability missing; cannot schedule tick");
		return;
	}
	const url = `${siteUrl(ctx)}/_emdash/api/plugins/scheduler/jobs.create`;
	const body = {
		type: "custom" as const,
		payload: { handler: "runs:tick", data: { runId } },
		runAt: new Date().toISOString(),
		source: `runs:${runId}`,
	};
	try {
		const res = await ctx.http.fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		if (!res.ok) {
			ctx.log.error("runs.scheduleNextTick: failed", { runId, status: res.status });
		}
	} catch (err) {
		ctx.log.error("runs.scheduleNextTick: error", {
			runId,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

async function tickAndMaybeReschedule(runId: string, ctx: PluginContext): Promise<void> {
	const result = await tickRun(runId, ctx, {
		resolveDriver: () =>
			resolveActiveDriver(process.env as Record<string, string | undefined>) as Driver | null,
		siteUrl: siteUrl(ctx),
	});
	if (result.scheduleNextTick) {
		await scheduleNextTick(runId, ctx);
	}
}

/**
 * Re-invoke a previously gated tool call with `_force_execute: true`.
 * Used by `runs.approve` after a human approves a tool-approval pause:
 * the tool's own gate sees the flag and skips its pause envelope, so
 * the actual operation runs and we get a real result to append to the
 * run's message history.
 */
async function invokeForcedTool(
	toolCall: { id: string; function: { name: string; arguments: string } },
	run: Run,
	site: string,
	ctx: PluginContext,
): Promise<{ content: string; ok: boolean }> {
	if (!ctx.http) {
		return { content: JSON.stringify({ ok: false, error: "network:fetch missing" }), ok: false };
	}
	let parsed: Record<string, unknown> = {};
	try {
		parsed = JSON.parse(toolCall.function.arguments || "{}") as Record<string, unknown>;
	} catch {
		// fall through with parsed = {}
	}
	try {
		const res = await ctx.http.fetch(`${site}/_emdash/api/plugins/tools/tools.invoke`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				name: toolCall.function.name,
				arguments: { ...parsed, _force_execute: true },
				taskId: run.task_id,
				agentId: run.agent_id,
			}),
		});
		if (!res.ok) {
			return {
				content: JSON.stringify({ ok: false, error: `tools.invoke ${res.status}` }),
				ok: false,
			};
		}
		const json = (await res.json()) as {
			data?: { ok?: boolean; output?: unknown; error?: string };
		};
		const data = json.data ?? {};
		if (data.ok === false) {
			return { content: JSON.stringify({ ok: false, error: data.error }), ok: false };
		}
		return { content: JSON.stringify(data.output ?? null), ok: true };
	} catch (err) {
		const error = err instanceof Error ? err.message : String(err);
		return { content: JSON.stringify({ ok: false, error }), ok: false };
	}
}

async function appendApprovalEvent(
	ctx: PluginContext,
	run: Run,
	decision: "approve" | "deny",
	payload: Record<string, unknown>,
): Promise<void> {
	const events = (ctx.storage as unknown as {
		run_events: {
			query: (opts: {
				where?: Record<string, unknown>;
				orderBy?: Record<string, "asc" | "desc">;
				limit?: number;
			}) => Promise<{ items: Array<{ data: RunEvent }> }>;
			put: (id: string, data: RunEvent) => Promise<void>;
		};
	}).run_events;
	const result = await events.query({
		where: { run_id: run.id },
		orderBy: { ordinal: "desc" },
		limit: 1,
	});
	const ordinal = (result.items[0]?.data.ordinal ?? -1) + 1;
	const event: RunEvent = {
		id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
		run_id: run.id,
		ordinal,
		kind: "human-resume",
		payload: { decision, ...payload },
		created_at: NOW(),
	};
	await events.put(event.id, event);
}

async function eventsSince(
	ctx: PluginContext,
	runId: string,
	sinceOrdinal: number,
	limit: number,
): Promise<RunEvent[]> {
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
		where: { run_id: runId },
		orderBy: { ordinal: "asc" },
		limit: 1000,
	});
	return result.items
		.map((i) => i.data)
		.filter((e) => e.ordinal > sinceOrdinal)
		.slice(0, limit);
}

export default definePlugin({
	hooks: {
		"plugin:install": {
			handler: async (_event: unknown, ctx: PluginContext) => {
				ctx.log.info("Runs plugin installed");
			},
		},
	},

	routes: {
		"runs.start": {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const body = routeCtx.input as StartRunInput | null;
				if (!body || typeof body !== "object") return { ok: false, error: "Invalid input" };
				if (!body.agent_id || typeof body.agent_id !== "string") {
					return { ok: false, error: "agent_id required" };
				}
				let messages: ChatMessage[];
				try {
					messages = buildInitialMessages(body);
				} catch (err) {
					return { ok: false, error: err instanceof Error ? err.message : String(err) };
				}

				const driver = resolveActiveDriver(process.env as Record<string, string | undefined>);
				if (!driver) {
					return { ok: false, error: "No active LLM driver — set OPENROUTER_API_KEY etc." };
				}

				const model =
					body.model ?? driver.defaults?.chatModel ?? "anthropic/claude-haiku-4-5";

				const run: Run = {
					id: newRunId(),
					agent_id: body.agent_id,
					task_id: body.task_id,
					parent_run_id: body.parent_run_id,
					status: "queued",
					message_history: messages,
					tools: body.tools as ToolSpec[] | undefined,
					iteration: 0,
					limits: {
						max_iterations: body.max_iterations ?? DEFAULT_MAX_ITERATIONS,
						max_tokens: body.max_tokens,
						max_usd: body.max_usd,
						max_wallclock_ms: body.max_wallclock_ms ?? DEFAULT_MAX_WALLCLOCK_MS,
					},
					cost: { tokens_in: 0, tokens_out: 0, usd: 0, calls: 0 },
					cancel_requested: false,
					model,
					driver_id: driver.id,
					completion_input: { model, messages: [], tools: body.tools as ToolSpec[] | undefined },
					started_at: NOW(),
					updated_at: NOW(),
				};

				await ctx.storage.runs!.put(run.id, run);
				const startEvent: RunEvent = {
					id: `evt_${Date.now()}_start`,
					run_id: run.id,
					ordinal: 0,
					kind: "run-started",
					payload: {
						agent_id: run.agent_id,
						task_id: run.task_id,
						model: run.model,
						driver: run.driver_id,
						limits: run.limits,
					},
					created_at: NOW(),
				};
				await ctx.storage.run_events!.put(startEvent.id, startEvent);

				await scheduleNextTick(run.id, ctx);
				return { ok: true, run };
			},
		},

		"runs.get": {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const id = getQueryParam(routeCtx, "id");
				if (!id) return { ok: false, error: "id required" };
				const run = (await ctx.storage.runs!.get(id)) as Run | null;
				if (!run) return { ok: false, error: "Not found" };
				const recentEvents = await eventsSince(ctx, id, -1, 200);
				return { ok: true, run, events: recentEvents };
			},
		},

		"runs.list": {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const agent_id = getQueryParam(routeCtx, "agent_id");
				const task_id = getQueryParam(routeCtx, "task_id");
				const status = getQueryParam(routeCtx, "status");
				const limit = Math.min(
					Math.max(parseInt(getQueryParam(routeCtx, "limit") ?? "50", 10) || 50, 1),
					500,
				);
				const cursor = getQueryParam(routeCtx, "cursor") || undefined;
				const where: Record<string, string> = {};
				if (agent_id) where.agent_id = agent_id;
				if (task_id) where.task_id = task_id;
				if (status) where.status = status;
				const result = await ctx.storage.runs!.query({
					where: Object.keys(where).length > 0 ? where : undefined,
					orderBy: { started_at: "desc" },
					limit,
					cursor,
				});
				return {
					ok: true,
					runs: result.items.map((i) => i.data),
					cursor: result.cursor,
					hasMore: result.hasMore,
				};
			},
		},

		"runs.cancel": {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const body = routeCtx.input as { id?: string; reason?: string } | null;
				if (!body?.id) return { ok: false, error: "id required" };
				const run = (await ctx.storage.runs!.get(body.id)) as Run | null;
				if (!run) return { ok: false, error: "Not found" };
				if (
					run.status === "completed" ||
					run.status === "cancelled" ||
					run.status === "failed"
				) {
					return { ok: false, error: `Run already terminal: ${run.status}` };
				}
				run.cancel_requested = true;
				run.updated_at = NOW();
				await ctx.storage.runs!.put(run.id, run);
				// Schedule a tick so the loop sees the flag promptly.
				await scheduleNextTick(run.id, ctx);
				return { ok: true, run };
			},
		},

		"runs.pause": {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const body = routeCtx.input as { id?: string; reason?: string } | null;
				if (!body?.id) return { ok: false, error: "id required" };
				const run = (await ctx.storage.runs!.get(body.id)) as Run | null;
				if (!run) return { ok: false, error: "Not found" };
				if (run.status === "completed" || run.status === "cancelled" || run.status === "failed") {
					return { ok: false, error: `Run already terminal: ${run.status}` };
				}
				run.status = "paused";
				run.paused_for_human = {
					kind: "operator",
					payload: { reason: body.reason ?? "operator paused" },
					created_at: NOW(),
				};
				run.updated_at = NOW();
				await ctx.storage.runs!.put(run.id, run);
				return { ok: true, run };
			},
		},

		"runs.resume": {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const body = routeCtx.input as { id?: string } | null;
				if (!body?.id) return { ok: false, error: "id required" };
				const run = (await ctx.storage.runs!.get(body.id)) as Run | null;
				if (!run) return { ok: false, error: "Not found" };
				if (run.status !== "paused" && run.status !== "awaiting_approval") {
					return { ok: false, error: `Run not paused (status: ${run.status})` };
				}
				run.status = "queued";
				run.paused_for_human = undefined;
				run.approval_token = undefined;
				run.updated_at = NOW();
				await ctx.storage.runs!.put(run.id, run);
				await scheduleNextTick(run.id, ctx);
				return { ok: true, run };
			},
		},

		"runs.tick": {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const body = routeCtx.input as { id?: string } | null;
				if (!body?.id) return { ok: false, error: "id required" };
				await tickAndMaybeReschedule(body.id, ctx);
				const run = (await ctx.storage.runs!.get(body.id)) as Run | null;
				return { ok: true, run };
			},
		},

		// =====================================================================
		// M3 — plan/tool approval routes
		// =====================================================================

		"runs.approve": {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const body = routeCtx.input as { id?: string; approval_token?: string } | null;
				if (!body?.id) return { ok: false, error: "id required" };
				const run = (await ctx.storage.runs!.get(body.id)) as Run | null;
				if (!run) return { ok: false, error: "Not found" };
				if (run.status !== "awaiting_approval") {
					return { ok: false, error: `Run not awaiting approval (status: ${run.status})` };
				}
				if (run.approval_token && body.approval_token && body.approval_token !== run.approval_token) {
					return { ok: false, error: "Invalid approval token" };
				}

				const pause = run.paused_for_human;
				if (!pause) {
					return { ok: false, error: "Run has no pending pause envelope" };
				}

				if (pause.kind === "tool-approval") {
					// Re-invoke the deferred tool with _force_execute to bypass
					// the tool's own gate. Append the real result to history.
					const toolCall = pause.payload.tool_call as
						| { id: string; type: "function"; function: { name: string; arguments: string } }
						| undefined;
					if (!toolCall) {
						return { ok: false, error: "Pause payload missing tool_call" };
					}
					const result = await invokeForcedTool(toolCall, run, siteUrl(ctx), ctx);
					run.message_history = [
						...run.message_history,
						{ role: "tool", tool_call_id: toolCall.id, content: result.content },
					];
					await appendApprovalEvent(ctx, run, "approve", { tool: toolCall.function.name });
				} else if (pause.kind === "plan-review") {
					// Plan stays in message_history; we add a synthetic user
					// message confirming approval so the model knows to proceed.
					run.message_history = [
						...run.message_history,
						{ role: "user", content: "Plan approved. Proceed with execution." },
					];
					await appendApprovalEvent(ctx, run, "approve", { kind: "plan-review" });
				}

				run.status = "queued";
				run.paused_for_human = undefined;
				run.approval_token = undefined;
				run.updated_at = NOW();
				await ctx.storage.runs!.put(run.id, run);
				await scheduleNextTick(run.id, ctx);
				return { ok: true, run };
			},
		},

		"runs.deny": {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const body = routeCtx.input as { id?: string; reason?: string } | null;
				if (!body?.id) return { ok: false, error: "id required" };
				const run = (await ctx.storage.runs!.get(body.id)) as Run | null;
				if (!run) return { ok: false, error: "Not found" };
				if (run.status !== "awaiting_approval") {
					return { ok: false, error: `Run not awaiting approval (status: ${run.status})` };
				}
				const pause = run.paused_for_human;
				const reason = body.reason ?? "Operator denied the requested action";

				if (pause?.kind === "tool-approval") {
					// Synthesize a denial tool result so the model can react and
					// either revise or stop.
					const toolCall = pause.payload.tool_call as
						| { id: string; function: { name: string } }
						| undefined;
					if (toolCall?.id) {
						run.message_history = [
							...run.message_history,
							{
								role: "tool",
								tool_call_id: toolCall.id,
								content: JSON.stringify({ ok: false, error: `denied: ${reason}` }),
							},
						];
					}
					await appendApprovalEvent(ctx, run, "deny", {
						tool: toolCall?.function.name,
						reason,
					});
				} else if (pause?.kind === "plan-review") {
					run.message_history = [
						...run.message_history,
						{ role: "user", content: `Plan denied: ${reason}. Revise or stop.` },
					];
					await appendApprovalEvent(ctx, run, "deny", { kind: "plan-review", reason });
				}

				run.status = "queued";
				run.paused_for_human = undefined;
				run.approval_token = undefined;
				run.updated_at = NOW();
				await ctx.storage.runs!.put(run.id, run);
				await scheduleNextTick(run.id, ctx);
				return { ok: true, run };
			},
		},

		// M9 — pre-publish validation. Anyone with a content draft can
		// call this to get the structured ValidationReport before
		// staging a publish. The runs harness can also call it
		// internally before pausing for approval (a future tightening).
		"runs.validate": {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const body = routeCtx.input as
					| { collection?: string; id?: string | null; data?: Record<string, unknown> }
					| null;
				if (!body || typeof body !== "object" || !body.collection || !body.data) {
					return { ok: false, error: "collection and data required" };
				}
				const report = await runValidators({
					collection: body.collection,
					id: body.id ?? null,
					data: body.data,
					plugin: ctx,
				});
				return { ok: report.ok, report };
			},
		},

		"runs.usageSummary": {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const period = (getQueryParam(routeCtx, "period") ?? "24h") as UsagePeriod;
				const group_by = (getQueryParam(routeCtx, "group_by") ?? "agent") as UsageGroup;
				const limit = 5000;
				const result = await ctx.storage.runs!.query({
					orderBy: { started_at: "desc" },
					limit,
				});
				const runs = result.items.map((i) => i.data) as Run[];
				return { ok: true, summary: aggregateUsage(runs, period, group_by) };
			},
		},

		"runs.events": {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const run_id = getQueryParam(routeCtx, "run_id");
				if (!run_id) return { ok: false, error: "run_id required" };
				const sinceOrdinal = parseInt(getQueryParam(routeCtx, "since_ordinal") ?? "-1", 10);
				const limit = Math.min(
					Math.max(parseInt(getQueryParam(routeCtx, "limit") ?? "200", 10) || 200, 1),
					1000,
				);
				const events = await eventsSince(ctx, run_id, sinceOrdinal, limit);
				return { ok: true, events };
			},
		},

		admin: {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const interaction = routeCtx.input as { type?: string; page?: string };
				if (interaction.type !== "page_load" || interaction.page !== "/runs") {
					return { blocks: [] };
				}
				const result = await ctx.storage.runs!.query({
					orderBy: { started_at: "desc" },
					limit: 100,
				});
				return {
					blocks: [
						{ type: "header", text: "Runs" },
						{
							type: "table",
							blockId: "runs-table",
							columns: [
								{ key: "id", label: "ID", format: "text" },
								{ key: "agent_id", label: "Agent", format: "text" },
								{ key: "status", label: "Status", format: "badge" },
								{ key: "iteration", label: "Iter", format: "text" },
								{ key: "tokens", label: "Tokens", format: "text" },
								{ key: "usd", label: "USD", format: "text" },
								{ key: "started_at", label: "Started", format: "relative_time" },
							],
							rows: result.items.map((i) => {
								const run = i.data as Run;
								return {
									id: run.id,
									agent_id: run.agent_id,
									status: run.status,
									iteration: String(run.iteration),
									tokens: String(run.cost.tokens_in + run.cost.tokens_out),
									usd: run.cost.usd.toFixed(4),
									started_at: run.started_at,
								};
							}),
						},
					],
				};
			},
		},
	},
});
