/**
 * Scheduler Plugin for EmDash CMS
 *
 * One-shot scheduled jobs. EmDash's `ctx.cron` only handles recurring
 * cron expressions. The scheduler plugin fills the gap: arbitrary
 * one-time jobs that fire at a specific timestamp.
 *
 * Built-in job types:
 *
 *   - "publish"     — flip a content item's status to "published"
 *   - "unpublish"   — flip a content item back to "draft"
 *   - "automation"  — fire an automations routine on demand (one-shot
 *                     companion to the cron-driven trigger)
 *   - "custom"      — invoke a handler registered via
 *                     `@emdash-cms/plugin-scheduler/registry`
 *
 * The plugin also acts as the auto-publisher emdash core is missing:
 * on every minute it polls collections for content with a past
 * `scheduled_at`, flips them to published. This is paired with a
 * `content:afterSave` hook that auto-creates publish/unpublish jobs
 * from native `scheduled_at` and convention-named `unpublish_at`
 * fields.
 *
 * Event hooks emit `scheduler:job:done` and `scheduler:job:failed`
 * via the automations plugin (if installed) for downstream observers.
 */

import type { PluginDescriptor } from "emdash";

export type {
	AutomationJobPayload,
	CreateJobInput,
	CustomJobPayload,
	Job,
	JobPayload,
	JobStatus,
	PublishJobPayload,
	UnpublishJobPayload,
} from "./types.js";

export interface SchedulerOptions {
	/**
	 * How frequently the tick cron fires. Defaults to every minute.
	 * Set higher (e.g. "*\/5 * * * *") on busy systems if minute
	 * granularity isn't needed.
	 */
	tickSchedule?: string;
	/** Default max attempts for new jobs. Defaults to 3. */
	defaultMaxAttempts?: number;
}

export function schedulerPlugin(_options: SchedulerOptions = {}): PluginDescriptor {
	return {
		id: "scheduler",
		version: "0.0.1",
		format: "standard",
		entrypoint: "@emdash-cms/plugin-scheduler/sandbox",
		options: {},
		capabilities: ["read:content", "write:content", "network:fetch"],
		// Internal plugin routes are allowed by the core HTTP layer;
		// no external hosts are required for the automation-job runner.
		allowedHosts: [],
		storage: {
			jobs: {
				indexes: ["status", "runAt", ["status", "runAt"], "type", "source"],
			},
		},
		adminPages: [{ path: "/scheduler", label: "Scheduler", icon: "clock" }],
		adminWidgets: [{ id: "scheduler-pending", title: "Pending jobs", size: "half" }],
	};
}
