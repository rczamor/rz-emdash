/**
 * Webform — runtime entrypoint.
 *
 * Routes:
 *   POST  /_emdash/api/plugins/webform/submit              public
 *   GET   /_emdash/api/plugins/webform/forms.list          admin
 *   POST  /_emdash/api/plugins/webform/forms.upsert        admin
 *   POST  /_emdash/api/plugins/webform/forms.delete        admin
 *   GET   /_emdash/api/plugins/webform/forms.get           admin
 *   GET   /_emdash/api/plugins/webform/submissions.list    admin
 *   GET   /_emdash/api/plugins/webform/submissions.export  admin (CSV)
 *   POST  /_emdash/api/plugins/webform/admin               Block Kit
 */

import { definePlugin } from "emdash";
import type { PluginContext } from "emdash";
import { resolveTokens } from "@emdash-cms/plugin-tokens/resolver";

import type { FieldDef, FormDefinition, SubmissionRecord } from "./types.js";

const HONEYPOT_FIELD = "_hp";
const RATE_LIMIT_PREFIX = "rl:";
const NOW = () => new Date().toISOString();

// ── Validation ──────────────────────────────────────────────────────────────

function validateField(raw: unknown, def: FieldDef): string | null {
	if (def.type === "checkbox") {
		if (def.required && !raw) return `${def.label} is required`;
		return null;
	}

	const value = raw == null ? "" : String(raw);
	if (def.required && value.trim() === "") return `${def.label} is required`;
	if (value === "") return null;

	if (def.minLength != null && value.length < def.minLength) {
		return `${def.label} must be at least ${def.minLength} characters`;
	}
	if (def.maxLength != null && value.length > def.maxLength) {
		return `${def.label} must be at most ${def.maxLength} characters`;
	}
	if (def.pattern && !new RegExp(def.pattern).test(value)) {
		return `${def.label} format is invalid`;
	}

	switch (def.type) {
		case "email":
			if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return `${def.label} must be an email`;
			break;
		case "url":
			try {
				const u = new URL(value);
				if (u.protocol !== "http:" && u.protocol !== "https:") {
					return `${def.label} must be a valid URL`;
				}
			} catch {
				return `${def.label} must be a valid URL`;
			}
			break;
		case "number": {
			const n = Number(value);
			if (Number.isNaN(n)) return `${def.label} must be a number`;
			if (def.min != null && n < def.min) return `${def.label} must be ≥ ${def.min}`;
			if (def.max != null && n > def.max) return `${def.label} must be ≤ ${def.max}`;
			break;
		}
		case "select":
		case "radio": {
			const allowed = new Set((def.options ?? []).map((o) => o.value));
			if (!allowed.has(value)) return `${def.label} is not a valid choice`;
			break;
		}
	}

	return null;
}

function validateSubmission(
	data: Record<string, unknown>,
	form: FormDefinition,
): Record<string, string> | null {
	const errors: Record<string, string> = {};
	for (const def of form.fields) {
		const err = validateField(data[def.name], def);
		if (err) errors[def.name] = err;
	}
	return Object.keys(errors).length > 0 ? errors : null;
}

// ── Rate limiting ───────────────────────────────────────────────────────────

async function rateLimitOk(
	form: FormDefinition,
	ip: string | undefined,
	ctx: PluginContext,
): Promise<boolean> {
	if (!form.rateLimit || !ip) return true;
	const key = `${RATE_LIMIT_PREFIX}${form.id}:${ip}`;
	const now = Math.floor(Date.now() / 1000);
	const windowStart = now - form.rateLimit.windowSeconds;

	const existing = (await ctx.kv.get<number[]>(key)) ?? [];
	const recent = existing.filter((ts) => ts > windowStart);
	if (recent.length >= form.rateLimit.maxSubmissions) return false;
	recent.push(now);
	await ctx.kv.set(key, recent);
	return true;
}

// ── Notifications ───────────────────────────────────────────────────────────

async function sendNotifications(
	form: FormDefinition,
	submission: SubmissionRecord,
	siteName: string,
	ctx: PluginContext,
): Promise<void> {
	if (!form.notifications?.length || !ctx.email) return;

	for (const n of form.notifications) {
		try {
			const tokenContext = {
				site: { name: siteName },
				form: { id: form.id, title: form.title },
				submission: submission.data,
			};
			const subject = await resolveTokens(n.subject, tokenContext);
			const text = await resolveTokens(n.body, tokenContext);
			await ctx.email.send({
				to: await resolveTokens(n.to, tokenContext),
				subject,
				text,
			});
		} catch (err) {
			ctx.log.error("Webform notification failed", {
				formId: form.id,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function newId(): string {
	return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function isValidFormId(id: unknown): id is string {
	return typeof id === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(id);
}

function csvEscape(s: unknown): string {
	const str = s == null ? "" : String(s);
	if (/[",\n\r]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
	return str;
}

function getQueryParam(routeCtx: { request: Request }, key: string): string | undefined {
	const url = new URL(routeCtx.request.url);
	return url.searchParams.get(key) ?? undefined;
}

interface RouteCtx {
	input: unknown;
	request: Request;
	requestMeta?: { ip?: string; userAgent?: string };
}

// ── Block Kit admin views ───────────────────────────────────────────────────

async function buildFormsListPage(ctx: PluginContext) {
	const result = await ctx.storage.forms.query({
		orderBy: { createdAt: "desc" },
		limit: 100,
	});
	return {
		blocks: [
			{ type: "header", text: "Webforms" },
			{
				type: "context",
				elements: [
					{
						type: "text",
						text: "Manage forms via the API. POST to /_emdash/api/plugins/webform/forms.upsert with a form definition.",
					},
				],
			},
			{
				type: "table",
				blockId: "webform-forms",
				columns: [
					{ key: "id", label: "ID", format: "text" },
					{ key: "title", label: "Title", format: "text" },
					{ key: "fields", label: "Fields", format: "text" },
					{ key: "enabled", label: "Status", format: "badge" },
					{ key: "createdAt", label: "Created", format: "relative_time" },
				],
				rows: result.items.map((item) => {
					const f = item.data as FormDefinition;
					return {
						id: f.id,
						title: f.title,
						fields: String(f.fields.length),
						enabled: f.enabled ? "Enabled" : "Disabled",
						createdAt: f.createdAt,
					};
				}),
			},
		],
	};
}

async function buildRecentWidget(ctx: PluginContext) {
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
				rows: result.items.map((item) => {
					const s = item.data as SubmissionRecord;
					return { formId: s.formId, status: s.status, createdAt: s.createdAt };
				}),
			},
		],
	};
}

// ── Plugin definition ───────────────────────────────────────────────────────

export default definePlugin({
	hooks: {
		"plugin:install": {
			handler: async (_event, ctx: PluginContext) => {
				ctx.log.info("Webform plugin installed");
			},
		},
	},

	routes: {
		// ── Public submission endpoint ─────────────────────────────────────
		submit: {
			public: true,
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const body = routeCtx.input as Record<string, unknown> | null;
				if (!body || typeof body !== "object") {
					return { ok: false, error: "Invalid request body" };
				}

				const formId = body.formId;
				if (!isValidFormId(formId)) return { ok: false, error: "Missing or invalid formId" };

				const stored = await ctx.storage.forms.get(formId);
				if (!stored) return { ok: false, error: "Form not found" };
				const form = stored as FormDefinition;
				if (!form.enabled) return { ok: false, error: "Form is disabled" };

				// Honeypot
				const data = (body.data ?? {}) as Record<string, unknown>;
				if (data[HONEYPOT_FIELD]) {
					ctx.log.warn("Webform honeypot tripped", { formId });
					return { ok: true }; // Pretend success to fool bots
				}
				delete data[HONEYPOT_FIELD];

				// Rate limit
				const ip = routeCtx.requestMeta?.ip;
				const allowed = await rateLimitOk(form, ip, ctx);
				if (!allowed) return { ok: false, error: "Too many submissions, try again later" };

				// Validation
				const errors = validateSubmission(data, form);
				if (errors) return { ok: false, errors };

				// Persist
				const submission: SubmissionRecord = {
					formId,
					data,
					status: "pending",
					ip,
					userAgent: routeCtx.requestMeta?.userAgent,
					createdAt: NOW(),
				};
				const subId = newId();
				await ctx.storage.submissions.put(subId, submission);

				// Notify (fire and forget — failures logged but not surfaced)
				const siteName = ctx.site?.name ?? "Site";
				sendNotifications(form, submission, siteName, ctx).catch((err) => {
					ctx.log.error("sendNotifications threw", {
						error: err instanceof Error ? err.message : String(err),
					});
				});

				return {
					ok: true,
					id: subId,
					confirmation: form.confirmation ?? { message: "Thanks for your submission" },
				};
			},
		},

		// ── Form management ────────────────────────────────────────────────
		"forms.list": {
			handler: async (_routeCtx: RouteCtx, ctx: PluginContext) => {
				const result = await ctx.storage.forms.query({
					orderBy: { createdAt: "desc" },
					limit: 200,
				});
				return { forms: result.items.map((item) => item.data) };
			},
		},

		"forms.get": {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const id = getQueryParam(routeCtx, "id");
				if (!isValidFormId(id)) return { ok: false, error: "Missing or invalid id" };
				const form = await ctx.storage.forms.get(id);
				if (!form) return { ok: false, error: "Not found" };
				return { ok: true, form };
			},
		},

		"forms.upsert": {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const body = routeCtx.input as Partial<FormDefinition> | null;
				if (!body || typeof body !== "object") {
					return { ok: false, error: "Invalid form definition" };
				}
				if (!isValidFormId(body.id)) return { ok: false, error: "Invalid form id" };
				if (!body.title || typeof body.title !== "string") {
					return { ok: false, error: "Title required" };
				}
				if (!Array.isArray(body.fields) || body.fields.length === 0) {
					return { ok: false, error: "At least one field required" };
				}

				const existing = (await ctx.storage.forms.get(body.id)) as FormDefinition | null;
				const form: FormDefinition = {
					id: body.id,
					title: body.title,
					description: body.description,
					fields: body.fields as FieldDef[],
					notifications: body.notifications ?? [],
					confirmation: body.confirmation,
					rateLimit: body.rateLimit,
					enabled: body.enabled ?? true,
					createdAt: existing?.createdAt ?? NOW(),
					updatedAt: NOW(),
				};
				await ctx.storage.forms.put(form.id, form);
				return { ok: true, form };
			},
		},

		"forms.delete": {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const body = routeCtx.input as { id?: unknown } | null;
				if (!body || !isValidFormId(body.id)) {
					return { ok: false, error: "Invalid id" };
				}
				const removed = await ctx.storage.forms.delete(body.id);
				return { ok: true, removed };
			},
		},

		// ── Submissions ────────────────────────────────────────────────────
		"submissions.list": {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const formId = getQueryParam(routeCtx, "formId");
				const limit = Math.min(
					Math.max(parseInt(getQueryParam(routeCtx, "limit") ?? "50", 10) || 50, 1),
					500,
				);
				const cursor = getQueryParam(routeCtx, "cursor");
				const filter = formId ? { formId } : undefined;
				const result = await ctx.storage.submissions.query({
					filter,
					orderBy: { createdAt: "desc" },
					limit,
					cursor,
				});
				return {
					items: result.items.map((i) => ({ id: i.id, ...(i.data as object) })),
					cursor: result.cursor,
					hasMore: result.hasMore,
				};
			},
		},

		"submissions.export": {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const formId = getQueryParam(routeCtx, "formId");
				if (!isValidFormId(formId)) {
					return { ok: false, error: "formId query param required" };
				}
				const form = (await ctx.storage.forms.get(formId)) as FormDefinition | null;
				if (!form) return { ok: false, error: "Form not found" };

				const result = await ctx.storage.submissions.query({
					filter: { formId },
					orderBy: { createdAt: "desc" },
					limit: 10_000,
				});

				const headers = ["id", "createdAt", "status", "ip", ...form.fields.map((f) => f.name)];
				const rows = [headers.map(csvEscape).join(",")];
				for (const item of result.items) {
					const s = item.data as SubmissionRecord;
					const row = [
						item.id,
						s.createdAt,
						s.status,
						s.ip ?? "",
						...form.fields.map((f) => csvEscape(s.data[f.name])),
					];
					rows.push(row.join(","));
				}

				return { ok: true, csv: rows.join("\n"), filename: `${formId}-submissions.csv` };
			},
		},

		// ── Block Kit admin handler ────────────────────────────────────────
		admin: {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const interaction = routeCtx.input as {
					type?: string;
					page?: string;
					widget?: string;
				};

				if (interaction.type === "page_load" && interaction.page === "/forms") {
					return await buildFormsListPage(ctx);
				}
				if (interaction.type === "widget_load" && interaction.widget === "webform-recent") {
					return await buildRecentWidget(ctx);
				}
				return { blocks: [] };
			},
		},
	},
});
