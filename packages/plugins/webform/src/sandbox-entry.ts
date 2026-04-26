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
import {
	csvEscape,
	DEFAULT_MAX_FILE_BYTES,
	formatBytes,
	isValidFormId,
	mimeMatches,
	normaliseFileRefs,
	preprocessForStorage,
	sanitiseHtml,
	validateSubmission,
} from "./pure.js";
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

function getQueryParam(routeCtx: { request: Request }, key: string): string | undefined {
	const url = new URL(routeCtx.request.url);
	return url.searchParams.get(key) ?? undefined;
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

