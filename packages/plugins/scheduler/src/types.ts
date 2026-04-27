/**
 * Scheduler types.
 *
 * A `Job` is a single one-shot piece of work to run at or after `runAt`.
 * The job's `type` decides which handler executes. Built-in types are
 * `publish`, `unpublish`, `automation`, and `custom`. New types are
 * registered via `@emdash-cms/plugin-scheduler/registry`.
 */

export type JobStatus = "pending" | "running" | "done" | "failed" | "canceled";

export interface PublishJobPayload {
	collection: string;
	contentId: string;
}

export interface UnpublishJobPayload {
	collection: string;
	contentId: string;
}

export interface AutomationJobPayload {
	routineId: string;
	event?: Record<string, unknown>;
}

export interface CustomJobPayload {
	handler: string;
	data?: Record<string, unknown>;
}

export type JobPayload =
	| { type: "publish"; payload: PublishJobPayload }
	| { type: "unpublish"; payload: UnpublishJobPayload }
	| { type: "automation"; payload: AutomationJobPayload }
	| { type: "custom"; payload: CustomJobPayload };

export interface Job {
	id: string;
	type: "publish" | "unpublish" | "automation" | "custom";
	payload: PublishJobPayload | UnpublishJobPayload | AutomationJobPayload | CustomJobPayload;
	runAt: string;
	status: JobStatus;
	attempts: number;
	maxAttempts: number;
	lastError?: string;
	createdAt: string;
	startedAt?: string;
	finishedAt?: string;
	/** Optional creator tag — useful for reverse-lookup ("which job did I make for this content?") */
	source?: string;
}

export interface CreateJobInput {
	id?: string;
	type: Job["type"];
	payload: JobPayload | Job["payload"];
	runAt: string | Date;
	maxAttempts?: number;
	source?: string;
}
