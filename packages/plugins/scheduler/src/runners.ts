/**
 * Built-in job runners.
 *
 * Each runner takes a job + ctx and either resolves cleanly (success)
 * or throws (the engine records the error and increments `attempts`).
 */

import type { PluginContext } from "emdash";

import { getJobHandler } from "./registry.js";
import type {
	AutomationJobPayload,
	CustomJobPayload,
	Job,
	PublishJobPayload,
	UnpublishJobPayload,
} from "./types.js";

const TRAILING_SLASH_RE = /\/$/;

async function runPublish(payload: PublishJobPayload, ctx: PluginContext): Promise<void> {
	if (!ctx.content) throw new Error("read:content + write:content capabilities required");
	const item = await ctx.content.get(payload.collection, payload.contentId);
	if (!item) throw new Error(`Content ${payload.collection}/${payload.contentId} not found`);
	const status = (item as { status?: string }).status;
	if (status === "published") {
		ctx.log.info("Scheduler: publish skipped, already published", payload);
		return;
	}
	await ctx.content.update!(payload.collection, payload.contentId, { status: "published" });
}

async function runUnpublish(payload: UnpublishJobPayload, ctx: PluginContext): Promise<void> {
	if (!ctx.content) throw new Error("read:content + write:content capabilities required");
	const item = await ctx.content.get(payload.collection, payload.contentId);
	if (!item) throw new Error(`Content ${payload.collection}/${payload.contentId} not found`);
	const status = (item as { status?: string }).status;
	if (status !== "published") {
		ctx.log.info("Scheduler: unpublish skipped, not currently published", payload);
		return;
	}
	await ctx.content.update!(payload.collection, payload.contentId, { status: "draft" });
}

async function runAutomation(payload: AutomationJobPayload, ctx: PluginContext): Promise<void> {
	// We don't import the automations engine directly to avoid a hard
	// cross-plugin dependency. Instead we POST to the automations
	// routines.test endpoint. The scheduler plugin already declares
	// network:fetch.
	if (!ctx.http) throw new Error("network:fetch capability required for automation jobs");
	const baseUrl = (ctx.site as { url?: string } | undefined)?.url ?? "http://localhost:4321";
	const res = await ctx.http.fetch(
		`${baseUrl.replace(TRAILING_SLASH_RE, "")}/_emdash/api/plugins/automations/routines.test`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ id: payload.routineId, event: payload.event }),
		},
	);
	if (!res.ok) {
		throw new Error(`Automations test endpoint returned ${res.status}`);
	}
}

async function runCustom(payload: CustomJobPayload, ctx: PluginContext): Promise<void> {
	const handler = getJobHandler(payload.handler);
	if (!handler) throw new Error(`Unknown custom handler: ${payload.handler}`);
	await handler(payload.data, ctx);
}

export async function runJob(job: Job, ctx: PluginContext): Promise<void> {
	switch (job.type) {
		case "publish":
			return runPublish(job.payload as PublishJobPayload, ctx);
		case "unpublish":
			return runUnpublish(job.payload as UnpublishJobPayload, ctx);
		case "automation":
			return runAutomation(job.payload as AutomationJobPayload, ctx);
		case "custom":
			return runCustom(job.payload as CustomJobPayload, ctx);
	}
}
