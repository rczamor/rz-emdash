/**
 * Tasks — runtime entrypoint.
 *
 * Routes:
 *   POST  tasks.create           CreateTaskInput
 *   GET   tasks.get?id=<id>
 *   GET   tasks.list?status=&assignee=&parent_id=&target_collection=&q=&limit=&cursor=
 *   POST  tasks.update           UpdateTaskInput
 *   POST  tasks.transition       TransitionTaskInput
 *   POST  tasks.assign           AssignTaskInput
 *   POST  tasks.comment          CommentTaskInput
 *   POST  tasks.delete           { id }
 *
 *   POST  cost.record            RecordCostInput
 *   POST  quota.check            QuotaCheckBody
 *
 *   POST  admin                  Block Kit
 *
 * Lifecycle event dispatch: every mutation calls
 * `dispatchEvent(<task:*>, <payload>, ctx)` so the Automations engine
 * runs matching routines.
 *
 * Sandboxing constraint: the cross-plugin import of automations'
 * `dispatchEvent` is trusted-mode only. In sandboxed mode each
 * plugin lives in its own isolate and the import resolves to a
 * separate engine instance with no routines registered. Document
 * accordingly.
 */

import { definePlugin } from "emdash";
import type { PluginContext } from "emdash";
import { dispatchEvent } from "@emdash-cms/plugin-automations/dispatch";

import { routeAdminInteraction, renderRefreshedView } from "./admin.js";
import { canTransition, isTerminal } from "./states.js";
import type {
	ActivityEntry,
	ActivityType,
	Actor,
	AssignTaskInput,
	CommentTaskInput,
	CostLedger,
	CreateTaskInput,
	RecordCostInput,
	Task,
	TaskStatus,
	TransitionTaskInput,
	UpdateTaskInput,
} from "./types.js";

interface RouteCtx {
	input: unknown;
	request: Request;
	requestMeta?: { ip?: string; userAgent?: string };
}

const NOW = () => new Date().toISOString();

function newId(): string {
	return `t_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function newActivityId(): string {
	return `a_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function getQueryParam(routeCtx: RouteCtx, key: string): string | undefined {
	return new URL(routeCtx.request.url).searchParams.get(key) ?? undefined;
}

function isValidId(id: unknown): id is string {
	return typeof id === "string" && id.length > 0 && id.length < 128;
}

function dayKey(date: Date = new Date()): string {
	return date.toISOString().slice(0, 10);
}

function emptyCost(): CostLedger {
	return { tokensIn: 0, tokensOut: 0, calls: 0 };
}

function appendActivity(
	task: Task,
	type: ActivityType,
	actor: Actor,
	data?: Record<string, unknown>,
): void {
	const entry: ActivityEntry = {
		id: newActivityId(),
		at: NOW(),
		actor,
		type,
		data,
	};
	task.activity.push(entry);
	task.updated_at = entry.at;
}

async function persistTask(task: Task, ctx: PluginContext): Promise<void> {
	await ctx.storage.tasks.put(task.id, task);
}

async function loadTask(id: string, ctx: PluginContext): Promise<Task | null> {
	const v = await ctx.storage.tasks.get(id);
	return (v as Task | null) ?? null;
}

// ── Mutation engine ─────────────────────────────────────────────────────────

async function createTask(input: CreateTaskInput, ctx: PluginContext): Promise<Task> {
	if (!input.goal || typeof input.goal !== "string" || !input.goal.trim()) {
		throw new Error("goal is required");
	}
	const id = input.id ?? newId();
	if (await ctx.storage.tasks.exists(id)) {
		throw new Error(`Task with id ${id} already exists`);
	}
	const task: Task = {
		id,
		parent_id: input.parent_id,
		goal: input.goal.trim(),
		description: input.description,
		target_collection: input.target_collection,
		target_id: input.target_id,
		assignee: input.assignee,
		created_by: input.created_by ?? "system",
		status: input.status ?? "backlog",
		deadline: input.deadline,
		publish_at: input.publish_at,
		depends_on: input.depends_on,
		output: input.output,
		cost: emptyCost(),
		activity: [],
		created_at: NOW(),
		updated_at: NOW(),
	};
	appendActivity(task, "created", task.created_by, {
		goal: task.goal,
		assignee: task.assignee,
		status: task.status,
	});
	await persistTask(task, ctx);

	dispatch("task:created", task, ctx).catch((err) => {
		ctx.log.error("Tasks: dispatch task:created failed", {
			error: err instanceof Error ? err.message : String(err),
		});
	});

	return task;
}

async function updateTask(input: UpdateTaskInput, ctx: PluginContext): Promise<Task> {
	if (!isValidId(input.id)) throw new Error("Invalid id");
	const task = await loadTask(input.id, ctx);
	if (!task) throw new Error("Not found");

	const changed: Record<string, unknown> = {};
	if (input.goal != null && input.goal !== task.goal) {
		task.goal = input.goal;
		changed.goal = input.goal;
	}
	if (input.description !== undefined) task.description = input.description;
	if (input.target_collection !== undefined) task.target_collection = input.target_collection;
	if (input.target_id !== undefined) task.target_id = input.target_id;
	if (input.deadline !== undefined) task.deadline = input.deadline;
	if (input.publish_at !== undefined) task.publish_at = input.publish_at;
	if (input.depends_on !== undefined) task.depends_on = input.depends_on;
	if (input.output !== undefined) task.output = input.output;

	if (Object.keys(changed).length > 0) {
		appendActivity(task, "updated", input.actor ?? "system", changed);
	} else {
		task.updated_at = NOW();
	}
	await persistTask(task, ctx);
	return task;
}

async function transitionTask(input: TransitionTaskInput, ctx: PluginContext): Promise<Task> {
	if (!isValidId(input.id)) throw new Error("Invalid id");
	const task = await loadTask(input.id, ctx);
	if (!task) throw new Error("Not found");
	const from = task.status;
	const to = input.to as TaskStatus;
	if (from === to) return task;
	if (!canTransition(from, to)) {
		throw new Error(`Cannot transition from "${from}" to "${to}"`);
	}

	task.status = to;
	appendActivity(task, "transitioned", input.actor ?? "system", { from, to, comment: input.comment });
	if (input.comment) {
		appendActivity(task, "commented", input.actor ?? "system", { text: input.comment });
	}
	await persistTask(task, ctx);

	// Fire derived events
	dispatch("task:transitioned", { task, from, to }, ctx).catch((err) =>
		ctx.log.error("Tasks: dispatch task:transitioned failed", {
			error: err instanceof Error ? err.message : String(err),
		}),
	);
	if (from === "pending_review" && (to === "approved" || to === "rejected")) {
		dispatch("task:reviewed", { task, decision: to }, ctx).catch(() => {});
	}
	if (isTerminal(to)) {
		dispatch("task:completed", { task, finalStatus: to }, ctx).catch(() => {});
	}

	return task;
}

async function assignTask(input: AssignTaskInput, ctx: PluginContext): Promise<Task> {
	if (!isValidId(input.id)) throw new Error("Invalid id");
	if (!input.assignee || typeof input.assignee !== "string") throw new Error("assignee required");
	const task = await loadTask(input.id, ctx);
	if (!task) throw new Error("Not found");
	const previous = task.assignee;
	task.assignee = input.assignee;
	appendActivity(task, "assigned", input.actor ?? "system", {
		previous,
		assignee: input.assignee,
	});
	await persistTask(task, ctx);
	dispatch("task:assigned", { task, previous, assignee: input.assignee }, ctx).catch(() => {});
	return task;
}

async function commentOnTask(input: CommentTaskInput, ctx: PluginContext): Promise<Task> {
	if (!isValidId(input.id)) throw new Error("Invalid id");
	if (!input.text || typeof input.text !== "string") throw new Error("text required");
	const task = await loadTask(input.id, ctx);
	if (!task) throw new Error("Not found");
	appendActivity(task, "commented", input.actor, { text: input.text });
	await persistTask(task, ctx);
	dispatch("task:commented", { task, text: input.text, actor: input.actor }, ctx).catch(() => {});
	return task;
}

// ── Cost ledger ─────────────────────────────────────────────────────────────

interface DailyCostRecord {
	day: string;
	actor: string;
	tokensIn: number;
	tokensOut: number;
	usd: number;
	calls: number;
	updatedAt: string;
}

function dailyKey(actor: string, day: string): string {
	return `${day}:${actor}`;
}

async function recordCost(input: RecordCostInput, ctx: PluginContext): Promise<Task> {
	if (!isValidId(input.id)) throw new Error("Invalid id");
	const task = await loadTask(input.id, ctx);
	if (!task) throw new Error("Not found");

	task.cost.tokensIn += input.tokensIn;
	task.cost.tokensOut += input.tokensOut;
	if (input.usd != null) task.cost.usd = (task.cost.usd ?? 0) + input.usd;
	task.cost.calls += 1;

	appendActivity(task, "cost", input.actor ?? "system", {
		model: input.model,
		tokensIn: input.tokensIn,
		tokensOut: input.tokensOut,
		usd: input.usd,
		source: input.source,
	});
	await persistTask(task, ctx);

	// Daily counter — keyed by assignee (the agent doing the work) so
	// daily quota is per-assignee. If unassigned, fall back to created_by.
	const billedActor = task.assignee ?? task.created_by;
	const day = dayKey();
	const key = dailyKey(billedActor, day);
	const existing = (await ctx.storage.daily_cost.get(key)) as DailyCostRecord | null;
	const next: DailyCostRecord = existing ?? {
		day,
		actor: billedActor,
		tokensIn: 0,
		tokensOut: 0,
		usd: 0,
		calls: 0,
		updatedAt: NOW(),
	};
	next.tokensIn += input.tokensIn;
	next.tokensOut += input.tokensOut;
	next.usd += input.usd ?? 0;
	next.calls += 1;
	next.updatedAt = NOW();
	await ctx.storage.daily_cost.put(key, next);

	dispatch("task:cost-recorded", { task, model: input.model, tokensIn: input.tokensIn, tokensOut: input.tokensOut, usd: input.usd }, ctx).catch(() => {});
	return task;
}

interface QuotaCheckBody {
	taskId?: string;
	actor: string;
	estimatedTokensIn?: number;
	estimatedTokensOut?: number;
}

interface QuotaCheckResult {
	ok: boolean;
	dailyTokensUsed?: number;
	dailyTokensLimit?: number;
	taskTokensUsed?: number;
	taskTokensLimit?: number;
	reason?: string;
}

const QUOTA_DAILY_KEY = "settings:dailyTokenQuota";
const QUOTA_TASK_KEY = "settings:taskTokenQuota";

async function checkQuota(body: QuotaCheckBody, ctx: PluginContext): Promise<QuotaCheckResult> {
	const dailyLimit = (await ctx.kv.get<number>(QUOTA_DAILY_KEY)) ?? 0;
	const taskLimit = (await ctx.kv.get<number>(QUOTA_TASK_KEY)) ?? 0;

	const day = dayKey();
	const dailyRow = (await ctx.storage.daily_cost.get(dailyKey(body.actor, day))) as DailyCostRecord | null;
	const dailyUsed = (dailyRow?.tokensIn ?? 0) + (dailyRow?.tokensOut ?? 0);
	const projectedDaily = dailyUsed + (body.estimatedTokensIn ?? 0) + (body.estimatedTokensOut ?? 0);

	if (dailyLimit > 0 && projectedDaily > dailyLimit) {
		return {
			ok: false,
			dailyTokensUsed: dailyUsed,
			dailyTokensLimit: dailyLimit,
			reason: `Daily token quota exceeded (${dailyUsed}+${(body.estimatedTokensIn ?? 0) + (body.estimatedTokensOut ?? 0)} > ${dailyLimit})`,
		};
	}

	let taskUsed = 0;
	if (body.taskId) {
		const task = await loadTask(body.taskId, ctx);
		if (task) taskUsed = task.cost.tokensIn + task.cost.tokensOut;
		const projectedTask = taskUsed + (body.estimatedTokensIn ?? 0) + (body.estimatedTokensOut ?? 0);
		if (taskLimit > 0 && projectedTask > taskLimit) {
			return {
				ok: false,
				dailyTokensUsed: dailyUsed,
				dailyTokensLimit: dailyLimit,
				taskTokensUsed: taskUsed,
				taskTokensLimit: taskLimit,
				reason: `Task token quota exceeded (${taskUsed}+${(body.estimatedTokensIn ?? 0) + (body.estimatedTokensOut ?? 0)} > ${taskLimit})`,
			};
		}
	}

	return {
		ok: true,
		dailyTokensUsed: dailyUsed,
		dailyTokensLimit: dailyLimit,
		taskTokensUsed: taskUsed,
		taskTokensLimit: taskLimit,
	};
}

// ── Event dispatch ──────────────────────────────────────────────────────────

async function dispatch(
	source: string,
	payload: unknown,
	ctx: PluginContext,
): Promise<void> {
	try {
		await dispatchEvent(source, payload as Record<string, unknown>, ctx);
	} catch (err) {
		ctx.log.warn("Tasks: dispatch failed", {
			source,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

// ── Plugin definition ───────────────────────────────────────────────────────

export default definePlugin({
	hooks: {
		"plugin:install": {
			handler: async (_event, ctx: PluginContext) => {
				ctx.log.info("Tasks plugin installed");
			},
		},
	},

	routes: {
		"tasks.create": {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				try {
					const task = await createTask(routeCtx.input as CreateTaskInput, ctx);
					return { ok: true, task };
				} catch (err) {
					return { ok: false, error: err instanceof Error ? err.message : String(err) };
				}
			},
		},

		"tasks.get": {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const id = getQueryParam(routeCtx, "id");
				if (!isValidId(id)) return { ok: false, error: "id required" };
				const task = await loadTask(id, ctx);
				if (!task) return { ok: false, error: "Not found" };
				return { ok: true, task };
			},
		},

		"tasks.list": {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const status = getQueryParam(routeCtx, "status");
				const assignee = getQueryParam(routeCtx, "assignee");
				const parent_id = getQueryParam(routeCtx, "parent_id");
				const target_collection = getQueryParam(routeCtx, "target_collection");
				const q = getQueryParam(routeCtx, "q");
				const limit = Math.min(
					Math.max(parseInt(getQueryParam(routeCtx, "limit") ?? "100", 10) || 100, 1),
					500,
				);
				const cursor = getQueryParam(routeCtx, "cursor");

				const filter: Record<string, unknown> = {};
				if (status) filter.status = status;
				if (assignee) filter.assignee = assignee;
				if (parent_id) filter.parent_id = parent_id;
				if (target_collection) filter.target_collection = target_collection;

				const result = await ctx.storage.tasks.query({
					filter: Object.keys(filter).length > 0 ? filter : undefined,
					orderBy: { created_at: "desc" },
					limit,
					cursor,
				});
				let items = result.items.map((i) => i.data as Task);
				if (q) {
					const lower = q.toLowerCase();
					items = items.filter(
						(t) =>
							t.goal.toLowerCase().includes(lower) ||
							(t.description ?? "").toLowerCase().includes(lower),
					);
				}
				return { tasks: items, cursor: result.cursor, hasMore: result.hasMore };
			},
		},

		"tasks.update": {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				try {
					const task = await updateTask(routeCtx.input as UpdateTaskInput, ctx);
					return { ok: true, task };
				} catch (err) {
					return { ok: false, error: err instanceof Error ? err.message : String(err) };
				}
			},
		},

		"tasks.transition": {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				try {
					const task = await transitionTask(routeCtx.input as TransitionTaskInput, ctx);
					return { ok: true, task };
				} catch (err) {
					return { ok: false, error: err instanceof Error ? err.message : String(err) };
				}
			},
		},

		"tasks.assign": {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				try {
					const task = await assignTask(routeCtx.input as AssignTaskInput, ctx);
					return { ok: true, task };
				} catch (err) {
					return { ok: false, error: err instanceof Error ? err.message : String(err) };
				}
			},
		},

		"tasks.comment": {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				try {
					const body = routeCtx.input as CommentTaskInput;
					const task = await commentOnTask(body, ctx);
					return { ok: true, task };
				} catch (err) {
					return { ok: false, error: err instanceof Error ? err.message : String(err) };
				}
			},
		},

		"tasks.delete": {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const body = routeCtx.input as { id?: unknown } | null;
				if (!body || !isValidId(body.id)) return { ok: false, error: "id required" };
				const removed = await ctx.storage.tasks.delete(body.id);
				return { ok: true, removed };
			},
		},

		"cost.record": {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				try {
					const task = await recordCost(routeCtx.input as RecordCostInput, ctx);
					return { ok: true, task };
				} catch (err) {
					return { ok: false, error: err instanceof Error ? err.message : String(err) };
				}
			},
		},

		"quota.check": {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const body = routeCtx.input as QuotaCheckBody | null;
				if (!body || !body.actor) {
					return { ok: false, error: "actor required" };
				}
				const result = await checkQuota(body, ctx);
				return result;
			},
		},

		"quota.set": {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const body = routeCtx.input as { dailyTokens?: number; taskTokens?: number } | null;
				if (!body) return { ok: false, error: "Body required" };
				if (body.dailyTokens != null) await ctx.kv.set(QUOTA_DAILY_KEY, Number(body.dailyTokens));
				if (body.taskTokens != null) await ctx.kv.set(QUOTA_TASK_KEY, Number(body.taskTokens));
				return { ok: true };
			},
		},

		admin: {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const interaction = routeCtx.input as Parameters<typeof routeAdminInteraction>[0];
				const decision = await routeAdminInteraction(interaction, ctx);

				if (decision.kind === "view") {
					return { blocks: decision.blocks };
				}

				// Run the requested mutation through the same engine the
				// public routes use, then re-render the relevant view.
				let toastMessage = "";
				let toastType: "success" | "error" = "success";
				try {
					if (decision.effect.transition) {
						await transitionTask(
							{
								id: decision.effect.transition.id,
								to: decision.effect.transition.to,
								actor: "human:admin",
							},
							ctx,
						);
						toastMessage = `Transitioned to ${decision.effect.transition.to}`;
					}
					if (decision.effect.assign) {
						await assignTask(
							{ id: decision.effect.assign.id, assignee: decision.effect.assign.assignee, actor: "human:admin" },
							ctx,
						);
						toastMessage = `Assigned to ${decision.effect.assign.assignee}`;
					}
					if (decision.effect.comment) {
						await commentOnTask(
							{ id: decision.effect.comment.id, text: decision.effect.comment.text, actor: "human:admin" },
							ctx,
						);
						toastMessage = "Comment posted";
					}
				} catch (err) {
					toastMessage = err instanceof Error ? err.message : String(err);
					toastType = "error";
				}

				const blocks = await renderRefreshedView(decision.refresh.taskId, ctx);
				return { blocks, toast: { message: toastMessage, type: toastType } };
			},
		},
	},
});
