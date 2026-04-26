/**
 * Shared types for the Webform plugin.
 *
 * Forms are stored as JSON in plugin storage. Submissions reference the form
 * by id. Field definitions are kept simple in v1 — eight common types,
 * no conditional logic, no multi-step.
 */

export type FieldType =
	| "text"
	| "email"
	| "textarea"
	| "number"
	| "url"
	| "tel"
	| "select"
	| "radio"
	| "checkbox"
	| "hidden";

export interface FieldOption {
	value: string;
	label: string;
}

export interface FieldDef {
	name: string;
	type: FieldType;
	label: string;
	required?: boolean;
	placeholder?: string;
	helpText?: string;
	defaultValue?: string;
	min?: number;
	max?: number;
	minLength?: number;
	maxLength?: number;
	pattern?: string;
	options?: FieldOption[];
}

export interface NotificationConfig {
	to: string;
	subject: string;
	body: string;
	replyToField?: string;
}

export interface FormDefinition {
	id: string;
	title: string;
	description?: string;
	fields: FieldDef[];
	notifications?: NotificationConfig[];
	confirmation?: {
		message: string;
		redirectUrl?: string;
	};
	rateLimit?: {
		windowSeconds: number;
		maxSubmissions: number;
	};
	enabled: boolean;
	createdAt: string;
	updatedAt: string;
}

export interface SubmissionRecord {
	formId: string;
	data: Record<string, unknown>;
	status: "pending" | "spam" | "processed";
	ip?: string;
	userAgent?: string;
	createdAt: string;
}
