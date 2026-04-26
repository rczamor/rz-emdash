/**
 * Form-builder admin UI (Block Kit).
 *
 * Single admin route handles every interaction. Navigation between
 * "views" (list / edit / new field / edit field / etc.) happens by
 * returning different block trees in response to button or form-submit
 * actions — not by URL changes. The user stays on /forms throughout.
 *
 * Buttons carry context via `value`:
 *   "view_form"          value: "<formId>"
 *   "edit_field"         value: "<formId>:<fieldName>"
 *   "delete_field"       value: "<formId>:<fieldName>"
 *   "delete_notification" value: "<formId>:<index>"
 *   etc.
 */

import type { PluginContext } from "emdash";

import type { FieldDef, FieldType, FormDefinition, NotificationConfig } from "./types.js";

const FIELD_TYPE_OPTIONS: Array<{ value: FieldType; label: string }> = [
	{ value: "text", label: "Text" },
	{ value: "email", label: "Email" },
	{ value: "textarea", label: "Long text" },
	{ value: "html", label: "HTML editor" },
	{ value: "number", label: "Number" },
	{ value: "range", label: "Range" },
	{ value: "url", label: "URL" },
	{ value: "tel", label: "Phone" },
	{ value: "password", label: "Password" },
	{ value: "select", label: "Dropdown" },
	{ value: "radio", label: "Radio buttons" },
	{ value: "checkbox", label: "Single checkbox" },
	{ value: "checkbox-group", label: "Checkbox group" },
	{ value: "date", label: "Date" },
	{ value: "time", label: "Time" },
	{ value: "datetime-local", label: "Date + time" },
	{ value: "color", label: "Colour" },
	{ value: "file", label: "File upload" },
	{ value: "hidden", label: "Hidden" },
];

interface AdminInteraction {
	type?: string;
	page?: string;
	widget?: string;
	action_id?: string;
	value?: string;
	values?: Record<string, unknown>;
}

const NOW = () => new Date().toISOString();

function isValidFormId(id: unknown): id is string {
	return typeof id === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(id);
}

function isValidFieldName(name: unknown): name is string {
	return typeof name === "string" && /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(name);
}

async function loadForm(id: string, ctx: PluginContext): Promise<FormDefinition | null> {
	const stored = await ctx.storage.forms.get(id);
	return (stored as FormDefinition | null) ?? null;
}

async function saveForm(form: FormDefinition, ctx: PluginContext): Promise<void> {
	await ctx.storage.forms.put(form.id, { ...form, updatedAt: NOW() });
}

function parseDualValue(value: string | undefined): [string, string] | null {
	if (!value) return null;
	const idx = value.indexOf(":");
	if (idx === -1) return null;
	return [value.slice(0, idx), value.slice(idx + 1)];
}

function parseOptionsString(raw: unknown): Array<{ value: string; label: string }> {
	if (typeof raw !== "string" || !raw.trim()) return [];
	return raw
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => {
			const [v, ...rest] = line.split("=");
			const value = (v ?? "").trim();
			const label = rest.length ? rest.join("=").trim() : value;
			return { value, label };
		})
		.filter((o) => o.value);
}

function renderOptionsString(options: Array<{ value: string; label: string }> | undefined): string {
	if (!options) return "";
	return options.map((o) => (o.value === o.label ? o.value : `${o.value}=${o.label}`)).join("\n");
}

// ── Views ───────────────────────────────────────────────────────────────────

async function viewFormsList(ctx: PluginContext) {
	const result = await ctx.storage.forms.query({
		orderBy: { createdAt: "desc" },
		limit: 200,
	});
	const rows = result.items.map((item) => {
		const f = item.data as FormDefinition;
		return {
			id: f.id,
			title: f.title,
			fields: String(f.fields.length),
			steps: f.steps?.length ? String(f.steps.length) : "—",
			enabled: f.enabled ? "Enabled" : "Disabled",
			createdAt: f.createdAt,
		};
	});

	return {
		blocks: [
			{ type: "header", text: "Webforms" },
			{
				type: "actions",
				elements: [
					{ type: "button", text: "+ New form", action_id: "new_form", style: "primary" },
				],
			},
			{
				type: "table",
				blockId: "webform-forms",
				columns: [
					{ key: "id", label: "ID", format: "text" },
					{ key: "title", label: "Title", format: "text" },
					{ key: "fields", label: "Fields", format: "text" },
					{ key: "steps", label: "Steps", format: "text" },
					{ key: "enabled", label: "Status", format: "badge" },
					{ key: "createdAt", label: "Created", format: "relative_time" },
				],
				rows,
			},
			...result.items.flatMap((item) => {
				const f = item.data as FormDefinition;
				return [
					{
						type: "actions",
						elements: [
							{
								type: "button",
								text: `Edit ${f.id}`,
								action_id: "view_form",
								value: f.id,
							},
							{
								type: "button",
								text: "Duplicate",
								action_id: "duplicate_form",
								value: f.id,
							},
							{
								type: "button",
								text: "Delete",
								action_id: "delete_form",
								value: f.id,
								style: "danger",
								confirm: {
									title: "Delete form?",
									text: `${f.id} and all its submissions will be removed.`,
									confirm: "Delete",
									deny: "Cancel",
								},
							},
						],
					},
				];
			}),
		],
	};
}

function viewNewForm() {
	return {
		blocks: [
			{ type: "header", text: "New webform" },
			{
				type: "actions",
				elements: [{ type: "button", text: "← Back", action_id: "back_to_list" }],
			},
			{
				type: "form",
				block_id: "create_form",
				fields: [
					{ type: "text_input", action_id: "id", label: "Form ID (lowercase, hyphens)" },
					{ type: "text_input", action_id: "title", label: "Title" },
					{
						type: "text_input",
						action_id: "description",
						label: "Description (optional)",
						multiline: true,
					},
					{ type: "toggle", action_id: "enabled", label: "Enabled", initial_value: true },
				],
				submit: { label: "Create", action_id: "create_form" },
			},
		],
	};
}

function viewFormEditor(form: FormDefinition) {
	return {
		blocks: [
			{ type: "header", text: `Webform: ${form.title}` },
			{
				type: "context",
				elements: [{ type: "text", text: `id: ${form.id}` }],
			},
			{
				type: "actions",
				elements: [{ type: "button", text: "← Back to list", action_id: "back_to_list" }],
			},
			{ type: "divider" },

			// Metadata
			{
				type: "form",
				block_id: `metadata_${form.id}`,
				fields: [
					{ type: "text_input", action_id: "title", label: "Title", initial_value: form.title },
					{
						type: "text_input",
						action_id: "description",
						label: "Description",
						multiline: true,
						initial_value: form.description ?? "",
					},
					{
						type: "toggle",
						action_id: "enabled",
						label: "Enabled",
						initial_value: form.enabled,
					},
				],
				submit: { label: "Save metadata", action_id: `save_metadata|${form.id}` },
			},

			{ type: "divider" },
			{ type: "header", text: "Fields" },

			// Fields table
			form.fields.length > 0
				? {
						type: "table",
						blockId: `fields_${form.id}`,
						columns: [
							{ key: "name", label: "Name", format: "text" },
							{ key: "type", label: "Type", format: "text" },
							{ key: "label", label: "Label", format: "text" },
							{ key: "required", label: "Required", format: "badge" },
						],
						rows: form.fields.map((f) => ({
							name: f.name,
							type: f.type,
							label: f.label,
							required: f.required ? "Required" : "",
						})),
					}
				: {
						type: "context",
						elements: [{ type: "text", text: "No fields yet — add one below." }],
					},

			...form.fields.map((f) => ({
				type: "actions",
				elements: [
					{
						type: "button",
						text: `Edit ${f.name}`,
						action_id: "edit_field",
						value: `${form.id}:${f.name}`,
					},
					{
						type: "button",
						text: "Delete",
						action_id: "delete_field",
						value: `${form.id}:${f.name}`,
						style: "danger",
						confirm: {
							title: "Delete field?",
							text: `Field "${f.name}" will be removed.`,
							confirm: "Delete",
							deny: "Cancel",
						},
					},
				],
			})),

			{
				type: "actions",
				elements: [
					{
						type: "button",
						text: "+ Add field",
						action_id: "add_field",
						value: form.id,
						style: "primary",
					},
				],
			},

			{ type: "divider" },
			{ type: "header", text: "Notifications" },

			(form.notifications?.length ?? 0) > 0
				? {
						type: "table",
						blockId: `notifications_${form.id}`,
						columns: [
							{ key: "to", label: "To", format: "text" },
							{ key: "subject", label: "Subject", format: "text" },
						],
						rows: (form.notifications ?? []).map((n) => ({
							to: n.to,
							subject: n.subject,
						})),
					}
				: {
						type: "context",
						elements: [{ type: "text", text: "No notifications configured." }],
					},

			...(form.notifications ?? []).map((_n, i) => ({
				type: "actions",
				elements: [
					{
						type: "button",
						text: `Delete #${i + 1}`,
						action_id: "delete_notification",
						value: `${form.id}:${i}`,
						style: "danger",
					},
				],
			})),

			{
				type: "actions",
				elements: [
					{
						type: "button",
						text: "+ Add notification",
						action_id: "add_notification",
						value: form.id,
					},
				],
			},

			{ type: "divider" },
			{ type: "header", text: "Settings" },

			{
				type: "form",
				block_id: `settings_${form.id}`,
				fields: [
					{
						type: "number_input",
						action_id: "rateLimit_window",
						label: "Rate limit window (seconds, 0 = none)",
						initial_value: form.rateLimit?.windowSeconds ?? 0,
						min: 0,
					},
					{
						type: "number_input",
						action_id: "rateLimit_max",
						label: "Rate limit max submissions per window",
						initial_value: form.rateLimit?.maxSubmissions ?? 0,
						min: 0,
					},
					{
						type: "number_input",
						action_id: "limit_total",
						label: "Total submission limit (0 = unlimited)",
						initial_value: form.submissionLimits?.total ?? 0,
						min: 0,
					},
					{
						type: "number_input",
						action_id: "limit_perIp",
						label: "Per-IP submission limit (0 = unlimited)",
						initial_value: form.submissionLimits?.perIp ?? 0,
						min: 0,
					},
					{
						type: "text_input",
						action_id: "confirmation_message",
						label: "Confirmation message",
						initial_value: form.confirmation?.message ?? "Thanks for your submission",
					},
				],
				submit: { label: "Save settings", action_id: `save_settings|${form.id}` },
			},
		],
	};
}

function viewFieldEditor(form: FormDefinition, field: FieldDef | null) {
	const isNew = !field;
	const f = field ?? {
		name: "",
		type: "text" as FieldType,
		label: "",
		required: false,
	};
	return {
		blocks: [
			{ type: "header", text: isNew ? "Add field" : `Edit field: ${f.name}` },
			{
				type: "actions",
				elements: [
					{ type: "button", text: "← Back to form", action_id: "view_form", value: form.id },
				],
			},
			{
				type: "form",
				block_id: isNew ? `add_field_${form.id}` : `edit_field_${form.id}_${f.name}`,
				fields: [
					{
						type: "text_input",
						action_id: "name",
						label: "Field name (alphanumeric + underscore)",
						initial_value: f.name,
					},
					{
						type: "select",
						action_id: "type",
						label: "Field type",
						options: FIELD_TYPE_OPTIONS,
						initial_value: f.type,
					},
					{
						type: "text_input",
						action_id: "label",
						label: "Display label",
						initial_value: f.label,
					},
					{
						type: "toggle",
						action_id: "required",
						label: "Required",
						initial_value: f.required ?? false,
					},
					{
						type: "text_input",
						action_id: "placeholder",
						label: "Placeholder (optional)",
						initial_value: f.placeholder ?? "",
					},
					{
						type: "text_input",
						action_id: "helpText",
						label: "Help text (optional)",
						initial_value: f.helpText ?? "",
					},
					{
						type: "number_input",
						action_id: "minLength",
						label: "Min length (text/textarea, 0 = none)",
						initial_value: f.minLength ?? 0,
					},
					{
						type: "number_input",
						action_id: "maxLength",
						label: "Max length (0 = none)",
						initial_value: f.maxLength ?? 0,
					},
					{
						type: "text_input",
						action_id: "options",
						label: "Options (one per line; 'value' or 'value=label'). Used by select / radio / checkbox-group.",
						multiline: true,
						initial_value: renderOptionsString(f.options),
					},
				],
				submit: {
					label: isNew ? "Add field" : "Save field",
					action_id: isNew ? `create_field|${form.id}` : `save_field|${form.id}|${f.name}`,
				},
			},
		],
	};
}

function viewNotificationEditor(form: FormDefinition) {
	return {
		blocks: [
			{ type: "header", text: "Add notification" },
			{
				type: "actions",
				elements: [
					{ type: "button", text: "← Back to form", action_id: "view_form", value: form.id },
				],
			},
			{
				type: "form",
				block_id: `add_notification_${form.id}`,
				fields: [
					{
						type: "text_input",
						action_id: "to",
						label: "To (email or token, e.g. {site.email})",
					},
					{
						type: "text_input",
						action_id: "subject",
						label: "Subject (tokens supported)",
					},
					{
						type: "text_input",
						action_id: "body",
						label: "Body (tokens supported)",
						multiline: true,
					},
				],
				submit: { label: "Add", action_id: `create_notification|${form.id}` },
			},
		],
	};
}

// ── Field props extraction ──────────────────────────────────────────────────

function fieldDefFromValues(values: Record<string, unknown>): FieldDef {
	const minLength = Number(values.minLength ?? 0);
	const maxLength = Number(values.maxLength ?? 0);
	const optionsStr = values.options;
	const options = parseOptionsString(optionsStr);
	const def: FieldDef = {
		name: String(values.name ?? "").trim(),
		type: String(values.type ?? "text") as FieldType,
		label: String(values.label ?? "").trim(),
		required: Boolean(values.required),
		placeholder: values.placeholder ? String(values.placeholder) : undefined,
		helpText: values.helpText ? String(values.helpText) : undefined,
	};
	if (minLength > 0) def.minLength = minLength;
	if (maxLength > 0) def.maxLength = maxLength;
	if (options.length > 0) def.options = options;
	return def;
}

// ── Top-level dispatcher ────────────────────────────────────────────────────

export async function handleAdminInteraction(
	interaction: AdminInteraction,
	ctx: PluginContext,
) {
	// PAGE LOAD ─────────────────────────────────────────────────────────────
	if (interaction.type === "page_load") {
		if (interaction.page === "/forms") return await viewFormsList(ctx);
		if (typeof interaction.page === "string" && interaction.page.startsWith("/forms/")) {
			const formId = interaction.page.slice("/forms/".length).split("/")[0]!;
			if (isValidFormId(formId)) {
				const form = await loadForm(formId, ctx);
				if (form) return viewFormEditor(form);
			}
		}
	}

	// WIDGET LOAD ───────────────────────────────────────────────────────────
	if (interaction.type === "widget_load" && interaction.widget === "webform-recent") {
		const result = await ctx.storage.submissions.query({
			orderBy: { createdAt: "desc" },
			limit: 5,
		});
		return {
			blocks: [
				{ type: "header", text: "Recent submissions" },
				{
					type: "table",
					blockId: "webform-recent",
					columns: [
						{ key: "formId", label: "Form", format: "text" },
						{ key: "status", label: "Status", format: "badge" },
						{ key: "createdAt", label: "When", format: "relative_time" },
					],
					rows: result.items.map((item) => ({
						formId: (item.data as { formId: string }).formId,
						status: (item.data as { status: string }).status,
						createdAt: (item.data as { createdAt: string }).createdAt,
					})),
				},
			],
		};
	}

	// BLOCK ACTION (button clicks) ─────────────────────────────────────────
	if (interaction.type === "block_action") {
		const aid = interaction.action_id;

		if (aid === "back_to_list") return await viewFormsList(ctx);
		if (aid === "new_form") return viewNewForm();

		if (aid === "view_form" && isValidFormId(interaction.value)) {
			const form = await loadForm(interaction.value, ctx);
			if (form) return viewFormEditor(form);
		}

		if (aid === "delete_form" && isValidFormId(interaction.value)) {
			await ctx.storage.forms.delete(interaction.value);
			return {
				...(await viewFormsList(ctx)),
				toast: { message: `Form ${interaction.value} deleted`, type: "success" },
			};
		}

		if (aid === "duplicate_form" && isValidFormId(interaction.value)) {
			const original = await loadForm(interaction.value, ctx);
			if (!original) return await viewFormsList(ctx);
			let newId = `${original.id}-copy`;
			let n = 2;
			while (await ctx.storage.forms.exists(newId)) {
				newId = `${original.id}-copy-${n++}`;
			}
			const copy: FormDefinition = {
				...original,
				id: newId,
				title: `${original.title} (copy)`,
				createdAt: NOW(),
				updatedAt: NOW(),
			};
			await saveForm(copy, ctx);
			return {
				...viewFormEditor(copy),
				toast: { message: `Duplicated as ${newId}`, type: "success" },
			};
		}

		if (aid === "add_field" && isValidFormId(interaction.value)) {
			const form = await loadForm(interaction.value, ctx);
			if (form) return viewFieldEditor(form, null);
		}

		if (aid === "edit_field") {
			const parsed = parseDualValue(interaction.value);
			if (parsed) {
				const [fid, fname] = parsed;
				const form = await loadForm(fid, ctx);
				const field = form?.fields.find((f) => f.name === fname);
				if (form && field) return viewFieldEditor(form, field);
			}
		}

		if (aid === "delete_field") {
			const parsed = parseDualValue(interaction.value);
			if (parsed) {
				const [fid, fname] = parsed;
				const form = await loadForm(fid, ctx);
				if (form) {
					form.fields = form.fields.filter((f) => f.name !== fname);
					await saveForm(form, ctx);
					return {
						...viewFormEditor(form),
						toast: { message: `Field ${fname} removed`, type: "success" },
					};
				}
			}
		}

		if (aid === "add_notification" && isValidFormId(interaction.value)) {
			const form = await loadForm(interaction.value, ctx);
			if (form) return viewNotificationEditor(form);
		}

		if (aid === "delete_notification") {
			const parsed = parseDualValue(interaction.value);
			if (parsed) {
				const [fid, idxStr] = parsed;
				const idx = parseInt(idxStr, 10);
				const form = await loadForm(fid, ctx);
				if (form && form.notifications && Number.isFinite(idx)) {
					form.notifications.splice(idx, 1);
					await saveForm(form, ctx);
					return {
						...viewFormEditor(form),
						toast: { message: "Notification removed", type: "success" },
					};
				}
			}
		}
	}

	// FORM SUBMIT (the real work) ──────────────────────────────────────────
	if (interaction.type === "form_submit") {
		const aid = interaction.action_id ?? "";
		const values = interaction.values ?? {};

		if (aid === "create_form") {
			const id = String(values.id ?? "").trim();
			const title = String(values.title ?? "").trim();
			if (!isValidFormId(id)) {
				return {
					...viewNewForm(),
					toast: { message: "Invalid form id (lowercase, hyphens only)", type: "error" },
				};
			}
			if (await ctx.storage.forms.exists(id)) {
				return {
					...viewNewForm(),
					toast: { message: "A form with that id already exists", type: "error" },
				};
			}
			if (!title) {
				return { ...viewNewForm(), toast: { message: "Title required", type: "error" } };
			}
			const form: FormDefinition = {
				id,
				title,
				description: values.description ? String(values.description) : undefined,
				fields: [],
				notifications: [],
				enabled: Boolean(values.enabled),
				createdAt: NOW(),
				updatedAt: NOW(),
			};
			await saveForm(form, ctx);
			return {
				...viewFormEditor(form),
				toast: { message: "Form created — add fields below", type: "success" },
			};
		}

		// All "<verb>|<formId>(:<rest>)?" action ids
		const [verb, suffix] = aid.split("|");
		if (!verb || !suffix) {
			// No-op: unknown form_submit
			return await viewFormsList(ctx);
		}
		const [formId, ...rest] = suffix.split("|");
		if (!isValidFormId(formId)) return await viewFormsList(ctx);
		const form = await loadForm(formId, ctx);
		if (!form) return await viewFormsList(ctx);

		if (verb === "save_metadata") {
			form.title = String(values.title ?? form.title);
			form.description = values.description ? String(values.description) : undefined;
			form.enabled = Boolean(values.enabled);
			await saveForm(form, ctx);
			return {
				...viewFormEditor(form),
				toast: { message: "Metadata saved", type: "success" },
			};
		}

		if (verb === "save_settings") {
			const window = Number(values.rateLimit_window ?? 0);
			const max = Number(values.rateLimit_max ?? 0);
			if (window > 0 && max > 0) {
				form.rateLimit = { windowSeconds: window, maxSubmissions: max };
			} else {
				form.rateLimit = undefined;
			}
			const total = Number(values.limit_total ?? 0);
			const perIp = Number(values.limit_perIp ?? 0);
			if (total > 0 || perIp > 0) {
				form.submissionLimits = {};
				if (total > 0) form.submissionLimits.total = total;
				if (perIp > 0) form.submissionLimits.perIp = perIp;
			} else {
				form.submissionLimits = undefined;
			}
			form.confirmation = {
				message: String(values.confirmation_message ?? "Thanks for your submission"),
			};
			await saveForm(form, ctx);
			return {
				...viewFormEditor(form),
				toast: { message: "Settings saved", type: "success" },
			};
		}

		if (verb === "create_field") {
			const def = fieldDefFromValues(values);
			if (!isValidFieldName(def.name)) {
				return {
					...viewFieldEditor(form, null),
					toast: { message: "Invalid field name", type: "error" },
				};
			}
			if (form.fields.some((f) => f.name === def.name)) {
				return {
					...viewFieldEditor(form, null),
					toast: { message: "Field name already exists", type: "error" },
				};
			}
			form.fields.push(def);
			await saveForm(form, ctx);
			return {
				...viewFormEditor(form),
				toast: { message: `Field ${def.name} added`, type: "success" },
			};
		}

		if (verb === "save_field") {
			const oldName = rest[0];
			if (!oldName) return await viewFormsList(ctx);
			const def = fieldDefFromValues(values);
			if (!isValidFieldName(def.name)) {
				return {
					...viewFormEditor(form),
					toast: { message: "Invalid field name", type: "error" },
				};
			}
			const idx = form.fields.findIndex((f) => f.name === oldName);
			if (idx === -1) return await viewFormsList(ctx);
			form.fields[idx] = def;
			await saveForm(form, ctx);
			return {
				...viewFormEditor(form),
				toast: { message: `Field saved`, type: "success" },
			};
		}

		if (verb === "create_notification") {
			const n: NotificationConfig = {
				to: String(values.to ?? "").trim(),
				subject: String(values.subject ?? "").trim(),
				body: String(values.body ?? "").trim(),
			};
			if (!n.to || !n.subject) {
				return {
					...viewNotificationEditor(form),
					toast: { message: "To and Subject required", type: "error" },
				};
			}
			form.notifications = form.notifications ?? [];
			form.notifications.push(n);
			await saveForm(form, ctx);
			return {
				...viewFormEditor(form),
				toast: { message: "Notification added", type: "success" },
			};
		}
	}

	// Default: list view
	return await viewFormsList(ctx);
}
