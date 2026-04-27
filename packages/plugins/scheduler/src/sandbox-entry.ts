/**
 * Scheduler — runtime entrypoint.
 *
 * Routes:
 *   GET   jobs.list?status=&type=&limit=    admin
 *   GET   jobs.get?id=                      admin
 *   POST  jobs.create                       admin   body: CreateJobInput
 *   POST  jobs.cancel                       admin   body: { id }
 *   POST  jobs.runNow                       admin   body: { id }   — force-run regardless of runAt
 *   POST  admin                             Block Kit
 *
 * Hooks:
 *   plugin:install       — schedule the tick cron, set defaults
 *   plugin:activate      — ensure the tick cron is registered
 *   cron                 — every-minute tick: claim due jobs, run them
 *   content:afterSave    — auto-create publish job from native
 *                          scheduled_at, unpublish job from convention
 *                          field unpublish_at
 */

import { definePlugin } from "emdash";
import type { PluginContext, WhereValue } from "emdash";

import { normaliseJobPayload } from "./payload.js";
import { runJob } from "./runners.js";
import type { CreateJobInput, Job, JobStatus } from "./types.js";

const TICK_NAME = "scheduler:tick";
const TICK_SCHEDULE_KEY = "settings:tickSchedule";
const MAX_ATTEMPTS_KEY = "settings:defaultMaxAttempts";
const DEFAULT_TICK = "* * * * *";
const DEFAULT_MAX_ATTEMPTS = 3;

interface RouteCtx {
	input: unknown;
	request: Request;
}

const NOW = () => new Date().toISOString();

function getQueryParam(routeCtx: RouteCtx, key: string): string | undefined {
	return new URL(routeCtx.request.url).searchParams.get(key) ?? undefined;
}

function newId(): string {
	return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function ensureTickCron(ctx: PluginContext): Promise<void> {
	if (!ctx.cron) return;
	const schedule = (await ctx.kv.get<string>(TICK_SCHEDULE_KEY)) ?? DEFAULT_TICK;
	const list = await ctx.cron.list();
	const existing = list.find((t) => t.name === TICK_NAME);
	if (!existing) {
		await ctx.cron.schedule(TICK_NAME, { schedule });
	} else if (existing.schedule !== schedule) {
		await ctx.cron.cancel(TICK_NAME);
		await ctx.cron.schedule(TICK_NAME, { schedule });
	}
}

async function persistJob(job: Job, ctx: PluginContext): Promise<void> {
	await ctx.storage.jobs!.put(job.id, job);
}

async function loadJob(id: string, ctx: PluginContext): Promise<Job | null> {
	const v = await ctx.storage.jobs!.get(id);
	return (v as Job | null) ?? null;
}

function isValidStatus(value: unknown): value is JobStatus {
	return (
		typeof value === "string" &&
		(value === "pending" ||
			value === "running" ||
			value === "done" ||
			value === "failed" ||
			value === "canceled")
	);
}

async function createJob(input: CreateJobInput, ctx: PluginContext): Promise<Job> {
	const max =
		input.maxAttempts ?? (await ctx.kv.get<number>(MAX_ATTEMPTS_KEY)) ?? DEFAULT_MAX_ATTEMPTS;
	const runAtStr =
		input.runAt instanceof Date ? input.runAt.toISOString() : new Date(input.runAt).toISOString();
	const job: Job = {
		id: input.id ?? newId(),
		type: input.type,
		payload: normaliseJobPayload(input),
		runAt: runAtStr,
		status: "pending",
		attempts: 0,
		maxAttempts: max,
		createdAt: NOW(),
		source: input.source,
	};
	await persistJob(job, ctx);
	return job;
}

// ── Tick ────────────────────────────────────────────────────────────────────

async function executePendingJob(
	job: Job,
	ctx: PluginContext,
): Promise<{ processed: number; failed: number }> {
	if (job.status !== "pending") return { processed: 0, failed: 0 };

	job.status = "running";
	job.startedAt = NOW();
	job.attempts++;
	await persistJob(job, ctx);

	try {
		await runJob(job, ctx);
		job.status = "done";
		job.finishedAt = NOW();
		await persistJob(job, ctx);
		ctx.log.info("Scheduler: job done", { id: job.id, type: job.type });
		return { processed: 1, failed: 0 };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		job.lastError = msg;
		let failed = 0;
		if (job.attempts >= job.maxAttempts) {
			job.status = "failed";
			job.finishedAt = NOW();
			failed = 1;
			ctx.log.error("Scheduler: job failed terminally", {
				id: job.id,
				type: job.type,
				error: msg,
				attempts: job.attempts,
			});
		} else {
			// Re-queue for next tick. Exponential-ish backoff via
			// runAt += attempts * 60s.
			job.status = "pending";
			const backoffMs = job.attempts * 60_000;
			job.runAt = new Date(Date.now() + backoffMs).toISOString();
			ctx.log.warn("Scheduler: job will retry", {
				id: job.id,
				type: job.type,
				error: msg,
				attempts: job.attempts,
				nextRunAt: job.runAt,
			});
		}
		await persistJob(job, ctx);
		return { processed: 0, failed };
	}
}

async function tickOnce(ctx: PluginContext): Promise<{ processed: number; failed: number }> {
	const now = NOW();
	const due = await ctx.storage.jobs!.query({
		where: { status: "pending" },
		orderBy: { runAt: "asc" },
		limit: 100,
	});

	let processed = 0;
	let failed = 0;
	for (const item of due.items) {
		const job = item.data as Job;
		if (job.status !== "pending") continue;
		if (job.runAt > now) continue; // ordered asc, but defensive

		const stats = await executePendingJob(job, ctx);
		processed += stats.processed;
		failed += stats.failed;
	}
	return { processed, failed };
}

// ── Auto-create jobs from native scheduled_at + unpublish_at ────────────────

interface ContentEvent {
	collection: string;
	content: Record<string, unknown> & {
		id?: string;
		scheduled_at?: string | null;
		scheduledAt?: string | null;
		unpublish_at?: string | null;
		unpublishAt?: string | null;
		status?: string;
	};
	isNew: boolean;
}

async function reconcileContentJobs(event: ContentEvent, ctx: PluginContext): Promise<void> {
	const id = event.content.id;
	if (!id || typeof id !== "string") return;

	const scheduledAt = event.content.scheduled_at ?? event.content.scheduledAt;
	const unpublishAt = event.content.unpublish_at ?? event.content.unpublishAt;
	const tag = `content:${event.collection}:${id}`;

	const existing = await ctx.storage.jobs!.query({
		where: { source: tag, status: "pending" },
		limit: 50,
	});

	// Cancel any stale prior jobs we created for this content. A future
	// optimisation could update in place; full cancel/recreate is simpler
	// and idempotent.
	for (const item of existing.items) {
		const j = item.data as Job;
		j.status = "canceled";
		j.finishedAt = NOW();
		await persistJob(j, ctx);
	}

	const status = event.content.status;

	if (
		typeof scheduledAt === "string" &&
		scheduledAt &&
		new Date(scheduledAt).getTime() > Date.now() &&
		status !== "published"
	) {
		await createJob(
			{
				type: "publish",
				payload: { collection: event.collection, contentId: id },
				runAt: scheduledAt,
				source: tag,
			},
			ctx,
		);
	}
	if (
		typeof unpublishAt === "string" &&
		unpublishAt &&
		new Date(unpublishAt).getTime() > Date.now()
	) {
		await createJob(
			{
				type: "unpublish",
				payload: { collection: event.collection, contentId: id },
				runAt: unpublishAt,
				source: tag,
			},
			ctx,
		);
	}
}

// ── Block Kit admin ─────────────────────────────────────────────────────────

async function buildAdminPage(ctx: PluginContext) {
	const [pending, running, done, failed] = await Promise.all([
		ctx.storage.jobs!.count({ status: "pending" }),
		ctx.storage.jobs!.count({ status: "running" }),
		ctx.storage.jobs!.count({ status: "done" }),
		ctx.storage.jobs!.count({ status: "failed" }),
	]);

	const recent = await ctx.storage.jobs!.query({
		orderBy: { createdAt: "desc" },
		limit: 50,
	});

	return {
		blocks: [
			{ type: "header", text: "Scheduler" },
			{
				type: "stats",
				stats: [
					{ label: "Pending", value: String(pending) },
					{ label: "Running", value: String(running) },
					{ label: "Done", value: String(done) },
					{ label: "Failed", value: String(failed) },
				],
			},
			{ type: "header", text: "Recent jobs" },
			{
				type: "table",
				blockId: "scheduler-jobs",
				columns: [
					{ key: "id", label: "ID", format: "text" },
					{ key: "type", label: "Type", format: "text" },
					{ key: "status", label: "Status", format: "badge" },
					{ key: "runAt", label: "Run at", format: "relative_time" },
					{ key: "attempts", label: "Attempts", format: "text" },
					{ key: "source", label: "Source", format: "text" },
				],
				rows: recent.items.map((item) => {
					const j = item.data as Job;
					return {
						id: j.id.slice(0, 16),
						type: j.type,
						status: j.status,
						runAt: j.runAt,
						attempts: `${j.attempts}/${j.maxAttempts}`,
						source: j.source ?? "",
					};
				}),
			},
		],
	};
}

async function buildPendingWidget(ctx: PluginContext) {
	const result = await ctx.storage.jobs!.query({
		where: { status: "pending" },
		orderBy: { runAt: "asc" },
		limit: 5,
	});
	return {
		blocks: [
			{ type: "header", text: "Pending jobs" },
			{
				type: "table",
				blockId: "scheduler-pending-widget",
				columns: [
					{ key: "type", label: "Type", format: "text" },
					{ key: "runAt", label: "Runs at", format: "relative_time" },
				],
				rows: result.items.map((item) => {
					const j = item.data as Job;
					return { type: j.type, runAt: j.runAt };
				}),
			},
		],
	};
}

// ── Plugin definition ───────────────────────────────────────────────────────

export default definePlugin({
	hooks: {
		"plugin:install": {
			handler: async (_event: unknown, ctx: PluginContext) => {
				ctx.log.info("Scheduler plugin installed");
				await ensureTickCron(ctx);
			},
		},
		"plugin:activate": {
			handler: async (_event: unknown, ctx: PluginContext) => {
				await ensureTickCron(ctx);
			},
		},

		cron: {
			handler: async (event: { name?: string }, ctx: PluginContext) => {
				if (event.name !== TICK_NAME) return;
				const stats = await tickOnce(ctx);
				if (stats.processed + stats.failed > 0) {
					ctx.log.info("Scheduler: tick", stats);
				}
			},
		},

		"content:afterSave": {
			handler: async (event: unknown, ctx: PluginContext) => {
				try {
					await reconcileContentJobs(event as ContentEvent, ctx);
				} catch (err) {
					ctx.log.warn("Scheduler: content reconcile failed", {
						error: err instanceof Error ? err.message : String(err),
					});
				}
			},
		},
	},

	routes: {
		"jobs.list": {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const status = getQueryParam(routeCtx, "status");
				const type = getQueryParam(routeCtx, "type");
				const limit = Math.min(
					Math.max(parseInt(getQueryParam(routeCtx, "limit") ?? "100", 10) || 100, 1),
					500,
				);
				const filter: Record<string, WhereValue> = {};
				if (status && isValidStatus(status)) filter.status = status;
				if (type) filter.type = type;
				const result = await ctx.storage.jobs!.query({
					where: Object.keys(filter).length > 0 ? filter : undefined,
					orderBy: { createdAt: "desc" },
					limit,
				});
				return { jobs: result.items.map((i) => i.data) };
			},
		},

		"jobs.get": {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const id = getQueryParam(routeCtx, "id");
				if (!id) return { ok: false, error: "id required" };
				const job = await loadJob(id, ctx);
				if (!job) return { ok: false, error: "Not found" };
				return { ok: true, job };
			},
		},

		"jobs.create": {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const body = routeCtx.input as CreateJobInput | null;
				if (!body || !body.type || !body.runAt) {
					return { ok: false, error: "type + runAt required" };
				}
				if (!body.payload || typeof body.payload !== "object") {
					return { ok: false, error: "payload required" };
				}
				const job = await createJob(body, ctx);
				return { ok: true, job };
			},
		},

		"jobs.cancel": {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const body = routeCtx.input as { id?: string } | null;
				if (!body?.id) return { ok: false, error: "id required" };
				const job = await loadJob(body.id, ctx);
				if (!job) return { ok: false, error: "Not found" };
				if (job.status !== "pending") {
					return { ok: false, error: `Cannot cancel job in status ${job.status}` };
				}
				job.status = "canceled";
				job.finishedAt = NOW();
				await persistJob(job, ctx);
				return { ok: true, job };
			},
		},

		"jobs.runNow": {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const body = routeCtx.input as { id?: string } | null;
				if (!body?.id) return { ok: false, error: "id required" };
				const job = await loadJob(body.id, ctx);
				if (!job) return { ok: false, error: "Not found" };
				if (job.status !== "pending") {
					return { ok: false, error: `Cannot run job in status ${job.status}` };
				}
				job.runAt = NOW();
				await persistJob(job, ctx);
				const stats = await executePendingJob(job, ctx);
				return { ok: true, stats };
			},
		},

		admin: {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const interaction = routeCtx.input as {
					type?: string;
					page?: string;
					widget?: string;
				};
				if (interaction.type === "page_load" && interaction.page === "/scheduler") {
					return await buildAdminPage(ctx);
				}
				if (interaction.type === "widget_load" && interaction.widget === "scheduler-pending") {
					return await buildPendingWidget(ctx);
				}
				return { blocks: [] };
			},
		},
	},
});
