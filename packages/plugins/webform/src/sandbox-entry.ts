/**
 * Webform — runtime entrypoint.
 *
 * Routes:
 *   POST  submit                    public — accept a submission
 *   POST  upload                    public — upload a file (returns mediaId)
 *   GET   forms.list                admin
 *   GET   forms.get?id=<id>         admin
 *   POST  forms.upsert              admin
 *   POST  forms.delete              admin
 *   POST  forms.duplicate           admin
 *   GET   submissions.list          admin (filters: formId, status, from, to, q, limit, cursor)
 *   GET   submissions.get?id=<id>   admin
 *   GET   submissions.export        admin (CSV)
 *   POST  submissions.delete        admin
 *   POST  admin                     Block Kit
 */

import { definePlugin } from "emdash";
import type { PluginContext } from "emdash";
import { resolveTokens } from "@emdash-cms/plugin-tokens/resolver";

import { handleAdminInteraction } from "./form-builder.js";
import type {
	FieldDef,
	FieldType,
	FileRef,
	FormDefinition,
	FormStep,
	NotificationConfig,
	SubmissionLimits,
	SubmissionRecord,
	VisibleIf,
} from "./types.js";

const HONEYPOT_FIELD = "_hp";
const RATE_LIMIT_PREFIX = "rl:";
const NOW = () => new Date().toISOString();
const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;

// ── Conditional visibility ──────────────────────────────────────────────────

function isVisible(field: FieldDef, data: Record<string, unknown>): boolean {
	const cond: VisibleIf | undefined = field.visibleIf;
	if (!cond) return true;
	const other = data[cond.field];
	switch (cond.op) {
		case "eq":
			return other === cond.value;
		case "ne":
			return other !== cond.value;
		case "in":
			return Array.isArray(cond.value) && cond.value.includes(other);
		case "notIn":
			return Array.isArray(cond.value) && !cond.value.includes(other);
		case "contains":
			return String(other ?? "").includes(String(cond.value ?? ""));
		case "empty":
			return other == null || other === "" || (Array.isArray(other) && other.length === 0);
		case "notEmpty":
			return other != null && other !== "" && !(Array.isArray(other) && other.length === 0);
	}
}

// ── Field validation ────────────────────────────────────────────────────────

function validateString(value: string, def: FieldDef): string | null {
	if (def.minLength != null && value.length < def.minLength) {
		return `${def.label} must be at least ${def.minLength} characters`;
	}
	if (def.maxLength != null && value.length > def.maxLength) {
		return `${def.label} must be at most ${def.maxLength} characters`;
	}
	if (def.pattern && !new RegExp(def.pattern).test(value)) {
		return `${def.label} format is invalid`;
	}
	return null;
}

function validateField(raw: unknown, def: FieldDef): string | null {
	// Multi-value fields
	if (def.type === "checkbox") {
		if (def.required && !raw) return `${def.label} is required`;
		return null;
	}
	if (def.type === "checkbox-group") {
		const arr = Array.isArray(raw) ? raw.map(String) : [];
		if (def.required && arr.length === 0) return `${def.label}: pick at least one`;
		const allowed = new Set((def.options ?? []).map((o) => o.value));
		for (const v of arr) {
			if (!allowed.has(v)) return `${def.label}: "${v}" is not a valid choice`;
		}
		return null;
	}
	if (def.type === "file") {
		const refs = normaliseFileRefs(raw);
		if (def.required && refs.length === 0) return `${def.label} is required`;
		if (!def.multiple && refs.length > 1) return `${def.label}: only one file allowed`;
		const max = def.maxSizeBytes ?? DEFAULT_MAX_FILE_BYTES;
		for (const r of refs) {
			if (r.sizeBytes > max) {
				return `${def.label}: ${r.filename} exceeds ${formatBytes(max)}`;
			}
			if (def.accept && !mimeMatches(r.mimeType, r.filename, def.accept)) {
				return `${def.label}: ${r.filename} is not an allowed file type`;
			}
		}
		return null;
	}

	const value = raw == null ? "" : String(raw);
	if (def.required && value.trim() === "") return `${def.label} is required`;
	if (value === "") return null;

	const lengthErr = validateString(value, def);
	if (lengthErr) return lengthErr;

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
		case "number":
		case "range": {
			const n = Number(value);
			if (Number.isNaN(n)) return `${def.label} must be a number`;
			if (def.min != null && n < def.min) return `${def.label} must be ≥ ${def.min}`;
			if (def.max != null && n > def.max) return `${def.label} must be ≤ ${def.max}`;
			break;
		}
		case "date":
		case "datetime-local":
		case "time":
			if (Number.isNaN(new Date(`${value}${def.type === "time" ? "T" + value : ""}`).getTime())) {
				return `${def.label} is not a valid ${def.type}`;
			}
			break;
		case "color":
			if (!/^#[0-9a-fA-F]{6}$/.test(value)) return `${def.label} must be a hex colour`;
			break;
		case "select":
		case "radio": {
			const allowed = new Set((def.options ?? []).map((o) => o.value));
			if (!allowed.has(value)) return `${def.label} is not a valid choice`;
			break;
		}
		case "html":
			// Strip dangerous tags before validation. Final stored value is also sanitised below.
			break;
	}

	return null;
}

function validateSubmission(
	data: Record<string, unknown>,
	form: FormDefinition,
): Record<string, string> | null {
	const errors: Record<string, string> = {};
	for (const def of form.fields) {
		if (!isVisible(def, data)) continue;
		const err = validateField(data[def.name], def);
		if (err) errors[def.name] = err;
	}
	return Object.keys(errors).length > 0 ? errors : null;
}

// ── Light HTML sanitiser ────────────────────────────────────────────────────
// Strips script/style/event-handlers. Allows a small block/inline tag set.

const HTML_ALLOWED_TAGS = new Set([
	"p",
	"br",
	"strong",
	"b",
	"em",
	"i",
	"u",
	"a",
	"ul",
	"ol",
	"li",
	"h1",
	"h2",
	"h3",
	"h4",
	"blockquote",
	"code",
	"pre",
]);

function sanitiseHtml(input: string): string {
	if (!input) return "";
	let out = input;
	out = out.replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "");
	out = out.replace(/<\s*\/?\s*([a-zA-Z][a-zA-Z0-9]*)([^>]*)>/g, (full, tag, attrs) => {
		const lower = String(tag).toLowerCase();
		if (!HTML_ALLOWED_TAGS.has(lower)) return "";
		// Strip event handlers + javascript: URLs
		const cleanedAttrs = String(attrs)
			.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|\S+)/gi, "")
			.replace(/\s(href|src)\s*=\s*("javascript:[^"]*"|'javascript:[^']*')/gi, "");
		return full.startsWith("</")
			? `</${lower}>`
			: `<${lower}${cleanedAttrs}${attrs.endsWith("/") ? "" : ""}>`;
	});
	return out;
}

// ── File refs helpers ───────────────────────────────────────────────────────

function normaliseFileRefs(raw: unknown): FileRef[] {
	if (!raw) return [];
	const arr = Array.isArray(raw) ? raw : [raw];
	const out: FileRef[] = [];
	for (const r of arr) {
		if (
			r &&
			typeof r === "object" &&
			typeof (r as FileRef).mediaId === "string" &&
			typeof (r as FileRef).filename === "string" &&
			typeof (r as FileRef).mimeType === "string" &&
			typeof (r as FileRef).sizeBytes === "number"
		) {
			out.push(r as FileRef);
		}
	}
	return out;
}

function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
	return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function mimeMatches(mime: string, filename: string, accept: string): boolean {
	const tokens = accept
		.split(",")
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean);
	const lowerMime = mime.toLowerCase();
	const ext = filename.toLowerCase().match(/\.[^.]+$/)?.[0] ?? "";
	for (const tok of tokens) {
		if (tok.startsWith(".")) {
			if (ext === tok) return true;
		} else if (tok.endsWith("/*")) {
			if (lowerMime.startsWith(tok.slice(0, -1))) return true;
		} else if (tok === lowerMime) {
			return true;
		}
	}
	return false;
}

// ── Rate limiting + submission limits ───────────────────────────────────────

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

async function submissionLimitOk(
	form: FormDefinition,
	data: Record<string, unknown>,
	ip: string | undefined,
	ctx: PluginContext,
): Promise<{ ok: true } | { ok: false; reason: string }> {
	const limits: SubmissionLimits | undefined = form.submissionLimits;
	if (!limits) return { ok: true };

	if (limits.total != null) {
		const c = await ctx.storage.submissions.count({ formId: form.id });
		if (c >= limits.total) return { ok: false, reason: "Submission limit reached" };
	}
	if (limits.perIp != null && ip) {
		const c = await ctx.storage.submissions.count({ formId: form.id, ip });
		if (c >= limits.perIp) return { ok: false, reason: "Submission limit reached for this IP" };
	}
	if (limits.perEmail) {
		const email = data[limits.perEmail.fieldName];
		if (typeof email === "string" && email) {
			// Storage `count` only filters by indexed fields; emails aren't indexed,
			// so scan recent submissions and count manually.
			const result = await ctx.storage.submissions.query({
				filter: { formId: form.id },
				orderBy: { createdAt: "desc" },
				limit: 1000,
			});
			let n = 0;
			for (const item of result.items) {
				const sub = item.data as SubmissionRecord;
				if (sub.data[limits.perEmail.fieldName] === email) n++;
			}
			if (n >= limits.perEmail.max) return { ok: false, reason: "Submission limit reached" };
		}
	}
	return { ok: true };
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
		await deliverOne(n, form, submission, siteName, ctx);
	}
}

async function deliverOne(
	n: NotificationConfig,
	form: FormDefinition,
	submission: SubmissionRecord,
	siteName: string,
	ctx: PluginContext,
): Promise<void> {
	try {
		const tokenContext = {
			site: { name: siteName },
			form: { id: form.id, title: form.title },
			submission: submission.data,
		};
		const subject = await resolveTokens(n.subject, tokenContext);
		const text = await resolveTokens(n.body, tokenContext);
		const to = await resolveTokens(n.to, tokenContext);
		await ctx.email!.send({ to, subject, text });
	} catch (err) {
		ctx.log.error("Webform notification failed", {
			formId: form.id,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

// ── Misc helpers ────────────────────────────────────────────────────────────

function newId(): string {
	return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function isValidFormId(id: unknown): id is string {
	return typeof id === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(id);
}

function csvEscape(s: unknown): string {
	const str = s == null ? "" : typeof s === "object" ? JSON.stringify(s) : String(s);
	if (/[",\n\r]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
	return str;
}

function getQueryParam(routeCtx: { request: Request }, key: string): string | undefined {
	const url = new URL(routeCtx.request.url);
	return url.searchParams.get(key) ?? undefined;
}

function preprocessForStorage(
	data: Record<string, unknown>,
	form: FormDefinition,
): Record<string, unknown> {
	const out: Record<string, unknown> = { ...data };
	for (const f of form.fields) {
		if (out[f.name] == null) continue;
		if (f.type === "html" && typeof out[f.name] === "string") {
			out[f.name] = sanitiseHtml(out[f.name] as string);
		}
		if (f.type === "checkbox-group" && !Array.isArray(out[f.name])) {
			out[f.name] = [String(out[f.name])];
		}
		if (f.type === "password") {
			// Never persist plaintext passwords in submissions
			out[f.name] = "***";
		}
	}
	return out;
}

interface RouteCtx {
	input: unknown;
	request: Request;
	requestMeta?: { ip?: string; userAgent?: string };
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

				const data = (body.data ?? {}) as Record<string, unknown>;

				// Honeypot
				if (data[HONEYPOT_FIELD]) {
					ctx.log.warn("Webform honeypot tripped", { formId });
					return { ok: true };
				}
				delete data[HONEYPOT_FIELD];

				// Rate limit + submission limits
				const ip = routeCtx.requestMeta?.ip;
				if (!(await rateLimitOk(form, ip, ctx))) {
					return { ok: false, error: "Too many submissions, try again later" };
				}
				const limit = await submissionLimitOk(form, data, ip, ctx);
				if (!limit.ok) return { ok: false, error: limit.reason };

				// Validation (skips invisible fields)
				const errors = validateSubmission(data, form);
				if (errors) return { ok: false, errors };

				// Persist
				const cleaned = preprocessForStorage(data, form);
				const submission: SubmissionRecord = {
					formId,
					data: cleaned,
					status: "pending",
					ip,
					userAgent: routeCtx.requestMeta?.userAgent,
					createdAt: NOW(),
				};
				const subId = newId();
				await ctx.storage.submissions.put(subId, submission);

				// Notify (fire and forget)
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

		// ── Public file upload endpoint ────────────────────────────────────
		// Returns a FileRef the client then includes in the submission payload.
		// The caller is responsible for sending multipart/form-data.
		upload: {
			public: true,
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				if (!ctx.media) return { ok: false, error: "Media unavailable" };
				const req = routeCtx.request;
				const contentType = req.headers.get("content-type") ?? "";
				if (!contentType.startsWith("multipart/form-data")) {
					return { ok: false, error: "Use multipart/form-data with a 'file' field" };
				}
				const form = await req.formData();
				const formId = String(form.get("formId") ?? "");
				const fieldName = String(form.get("field") ?? "");
				const file = form.get("file");
				if (!isValidFormId(formId)) return { ok: false, error: "Invalid formId" };
				if (!file || typeof file === "string") return { ok: false, error: "No file" };

				const stored = await ctx.storage.forms.get(formId);
				if (!stored) return { ok: false, error: "Form not found" };
				const fdef = (stored as FormDefinition).fields.find(
					(f) => f.name === fieldName && f.type === "file",
				);
				if (!fdef) return { ok: false, error: "Field is not a file field" };

				const max = fdef.maxSizeBytes ?? DEFAULT_MAX_FILE_BYTES;
				if (file.size > max) {
					return { ok: false, error: `File exceeds ${formatBytes(max)}` };
				}
				if (fdef.accept && !mimeMatches(file.type, file.name, fdef.accept)) {
					return { ok: false, error: "File type not allowed" };
				}

				try {
					const media = ctx.media as {
						upload?: (
							filename: string,
							contentType: string,
							bytes: ArrayBuffer,
						) => Promise<{ mediaId: string }>;
					};
					if (!media.upload) {
						return { ok: false, error: "Media write capability missing" };
					}
					const buf = await file.arrayBuffer();
					const result = await media.upload(
						file.name,
						file.type || "application/octet-stream",
						buf,
					);
					const ref: FileRef = {
						mediaId: result.mediaId,
						filename: file.name,
						mimeType: file.type || "application/octet-stream",
						sizeBytes: file.size,
					};
					return { ok: true, ref };
				} catch (err) {
					ctx.log.error("Webform upload failed", {
						error: err instanceof Error ? err.message : String(err),
					});
					return { ok: false, error: "Upload failed" };
				}
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

				const fieldNames = new Set(body.fields.map((f) => f.name));
				if (fieldNames.size !== body.fields.length) {
					return { ok: false, error: "Field names must be unique" };
				}
				if (Array.isArray(body.steps)) {
					for (const step of body.steps as FormStep[]) {
						for (const fname of step.fields) {
							if (!fieldNames.has(fname)) {
								return { ok: false, error: `Step "${step.id}" references unknown field "${fname}"` };
							}
						}
					}
				}

				const existing = (await ctx.storage.forms.get(body.id)) as FormDefinition | null;
				const form: FormDefinition = {
					id: body.id,
					title: body.title,
					description: body.description,
					fields: body.fields as FieldDef[],
					steps: body.steps as FormStep[] | undefined,
					notifications: body.notifications ?? [],
					confirmation: body.confirmation,
					rateLimit: body.rateLimit,
					submissionLimits: body.submissionLimits,
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
				if (!body || !isValidFormId(body.id)) return { ok: false, error: "Invalid id" };
				const removed = await ctx.storage.forms.delete(body.id);
				return { ok: true, removed };
			},
		},

		"forms.duplicate": {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const body = routeCtx.input as { id?: unknown; newId?: unknown } | null;
				if (!body || !isValidFormId(body.id) || !isValidFormId(body.newId)) {
					return { ok: false, error: "Invalid id or newId" };
				}
				const existing = (await ctx.storage.forms.get(body.id)) as FormDefinition | null;
				if (!existing) return { ok: false, error: "Source form not found" };
				const collide = await ctx.storage.forms.exists(body.newId);
				if (collide) return { ok: false, error: "Target id already exists" };
				const copy: FormDefinition = {
					...existing,
					id: body.newId,
					title: existing.title + " (copy)",
					createdAt: NOW(),
					updatedAt: NOW(),
				};
				await ctx.storage.forms.put(copy.id, copy);
				return { ok: true, form: copy };
			},
		},

		// ── Submissions ────────────────────────────────────────────────────
		"submissions.list": {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const formId = getQueryParam(routeCtx, "formId");
				const status = getQueryParam(routeCtx, "status");
				const from = getQueryParam(routeCtx, "from");
				const to = getQueryParam(routeCtx, "to");
				const q = getQueryParam(routeCtx, "q");
				const limit = Math.min(
					Math.max(parseInt(getQueryParam(routeCtx, "limit") ?? "50", 10) || 50, 1),
					500,
				);
				const cursor = getQueryParam(routeCtx, "cursor");
				const filter: Record<string, unknown> = {};
				if (formId) filter.formId = formId;
				if (status) filter.status = status;
				const result = await ctx.storage.submissions.query({
					filter: Object.keys(filter).length ? filter : undefined,
					orderBy: { createdAt: "desc" },
					limit,
					cursor,
				});
				let items = result.items;
				if (from || to || q) {
					const fromTs = from ? new Date(from).getTime() : -Infinity;
					const toTs = to ? new Date(to).getTime() : Infinity;
					const qLower = q?.toLowerCase();
					items = items.filter((it) => {
						const s = it.data as SubmissionRecord;
						const ts = new Date(s.createdAt).getTime();
						if (ts < fromTs || ts > toTs) return false;
						if (qLower) {
							const blob = JSON.stringify(s.data).toLowerCase();
							if (!blob.includes(qLower)) return false;
						}
						return true;
					});
				}
				return {
					items: items.map((i) => ({ id: i.id, ...(i.data as object) })),
					cursor: result.cursor,
					hasMore: result.hasMore,
				};
			},
		},

		"submissions.get": {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const id = getQueryParam(routeCtx, "id");
				if (!id) return { ok: false, error: "id required" };
				const sub = await ctx.storage.submissions.get(id);
				if (!sub) return { ok: false, error: "Not found" };
				return { ok: true, submission: { id, ...(sub as object) } };
			},
		},

		"submissions.delete": {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const body = routeCtx.input as { id?: unknown } | null;
				if (!body || typeof body.id !== "string") return { ok: false, error: "id required" };
				const removed = await ctx.storage.submissions.delete(body.id);
				return { ok: true, removed };
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
				return await handleAdminInteraction(
					routeCtx.input as Parameters<typeof handleAdminInteraction>[0],
					ctx,
				);
			},
		},
	},
});

