import type { CreateJobInput, Job, JobPayload } from "./types.js";

/** Accept both the public CreateJobInput shape and the older nested JobPayload shape. */
export function normaliseJobPayload(input: CreateJobInput): Job["payload"] {
	const payload = input.payload as Partial<JobPayload>;
	if (
		payload &&
		typeof payload === "object" &&
		payload.type === input.type &&
		"payload" in payload
	) {
		return payload.payload as Job["payload"];
	}
	return input.payload as Job["payload"];
}
