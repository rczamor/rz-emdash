/**
 * Shared types for the Webform plugin.
 */

export type FieldType =
	| "text"
	| "email"
	| "textarea"
	| "html"
	| "number"
	| "range"
	| "url"
	| "tel"
	| "password"
	| "select"
	| "radio"
	| "checkbox"
	| "checkbox-group"
	| "hidden"
	| "date"
	| "time"
	| "datetime-local"
	| "color"
	| "file";

export interface FieldOption {
	value: string;
	label: string;
}

/**
 * Conditional visibility. `op` is checked against the value of the field
 * named in `field`. Comparisons are coerced to strings except for `eq`/`ne`
 * which use deep equality on the raw submitted value.
 */
export interface VisibleIf {
	field: string;
	op: "eq" | "ne" | "in" | "notIn" | "contains" | "empty" | "notEmpty";
	value?: unknown;
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
	step?: number;
	minLength?: number;
	maxLength?: number;
	pattern?: string;
	options?: FieldOption[];
	/** For file fields: comma-separated mime types or extensions (".pdf,.docx,image/*") */
	accept?: string;
	/** For file fields: maximum size in bytes (default 10MB) */
	maxSizeBytes?: number;
	/** For file fields: allow multiple */
	multiple?: boolean;
	/** Conditional visibility */
	visibleIf?: VisibleIf;
}

export interface NotificationConfig {
	to: string;
	subject: string;
	body: string;
	replyToField?: string;
}

export interface SubmissionLimits {
	/** Total submissions across all users */
	total?: number;
	/** Total submissions per unique IP */
	perIp?: number;
	/** Total submissions where a given email field equals the submitted value */
	perEmail?: { fieldName: string; max: number };
}

export interface FormStep {
	id: string;
	title: string;
	description?: string;
	fields: string[];
}

export interface FormDefinition {
	id: string;
	title: string;
	description?: string;
	fields: FieldDef[];
	/** When present, fields are paged. Each step lists which field names belong to it. */
	steps?: FormStep[];
	notifications?: NotificationConfig[];
	confirmation?: {
		message: string;
		redirectUrl?: string;
	};
	rateLimit?: {
		windowSeconds: number;
		maxSubmissions: number;
	};
	submissionLimits?: SubmissionLimits;
	enabled: boolean;
	createdAt: string;
	updatedAt: string;
}

export interface FileRef {
	mediaId: string;
	filename: string;
	mimeType: string;
	sizeBytes: number;
}

export interface SubmissionRecord {
	formId: string;
	data: Record<string, unknown>;
	status: "pending" | "spam" | "processed";
	ip?: string;
	userAgent?: string;
	createdAt: string;
}
