/**
 * Webform Plugin for EmDash CMS
 *
 * EmDash equivalent of Drupal's Webform module. Provides:
 *   - JSON-defined forms with eight common field types
 *   - Public submission endpoint with validation
 *   - Submission storage with indexed queries
 *   - Email notifications (uses ctx.email.send → routes through configured
 *     email provider plugin, e.g. Resend)
 *   - Honeypot anti-spam + per-IP rate limiting via KV
 *   - Block Kit admin UI listing forms + submissions
 *   - CSV export of submissions
 *
 * Notifications support tokens via @emdash-cms/plugin-tokens — e.g. an email
 * subject of "New {form.title} submission from {submission.email}" is
 * resolved at delivery time.
 *
 * Forms are CRUD'd via the plugin API routes (admin-only) or seeded from
 * code at install time.
 */

import type { PluginDescriptor } from "emdash";

export type {
	FieldDef,
	FieldOption,
	FieldType,
	FormDefinition,
	NotificationConfig,
	SubmissionRecord,
} from "./types.js";

export function webformPlugin(): PluginDescriptor {
	return {
		id: "webform",
		version: "0.0.1",
		format: "standard",
		entrypoint: "@emdash-cms/plugin-webform/sandbox",
		options: {},
		capabilities: ["email:send"],
		storage: {
			forms: { indexes: ["enabled", "createdAt"] },
			submissions: { indexes: ["formId", "status", "createdAt", ["formId", "createdAt"]] },
		},
		adminPages: [{ path: "/forms", label: "Webforms", icon: "list" }],
		adminWidgets: [{ id: "webform-recent", title: "Recent submissions", size: "half" }],
	};
}
