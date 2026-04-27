import type { FieldType, FormDefinition, FormField, Submission } from "../src/types.js";

export function field(
	name: string,
	type: FieldType,
	overrides: Partial<FormField> = {},
): FormField {
	return {
		id: `f-${name}`,
		name,
		type,
		label: overrides.label ?? name,
		required: false,
		width: "full",
		...overrides,
	};
}

export function form(fields: FormField[], overrides: Partial<FormDefinition> = {}): FormDefinition {
	return {
		name: "Test",
		slug: "test",
		pages: [{ fields }],
		settings: {
			confirmationMessage: "Thanks!",
			notifyEmails: [],
			digestEnabled: false,
			digestHour: 9,
			retentionDays: 30,
			spamProtection: "none",
			submitLabel: "Send",
		},
		status: "active",
		submissionCount: 0,
		lastSubmissionAt: null,
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
		...overrides,
	};
}

export function submission(data: Record<string, unknown>): Submission {
	return {
		formId: "test",
		data,
		status: "new",
		starred: false,
		createdAt: "2026-01-01T12:00:00Z",
		meta: { ip: null, userAgent: null, referer: null, country: null },
	};
}
