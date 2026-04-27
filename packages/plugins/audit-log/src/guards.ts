/**
 * Pure type guards — kept in their own module so unit tests can import
 * them without pulling in the `emdash` runtime through `sandbox-entry.ts`.
 */

export interface AuditEntry {
	timestamp: string;
	action: "create" | "update" | "delete" | "media:upload" | "media:delete";
	collection?: string;
	resourceId: string;
	resourceType: "content" | "media";
	userId?: string;
	changes?: {
		before?: Record<string, unknown>;
		after?: Record<string, unknown>;
	};
	metadata?: Record<string, unknown>;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isAuditEntry(value: unknown): value is AuditEntry {
	return (
		isRecord(value) &&
		typeof value.timestamp === "string" &&
		typeof value.action === "string" &&
		typeof value.resourceId === "string" &&
		typeof value.resourceType === "string"
	);
}
