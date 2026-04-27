/**
 * Pure validation + helpers extracted from sandbox-entry for testability.
 *
 * No I/O, no plugin context — just functions over plain data.
 */

import type { FieldDef, FileRef, FormDefinition, VisibleIf } from "./types.js";

export const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const COLOR_HEX_RE = /^#[0-9a-fA-F]{6}$/;
const SCRIPT_STYLE_TAG_RE = /<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi;
const HTML_TAG_RE = /<\s*\/?\s*([a-zA-Z][a-zA-Z0-9]*)([^>]*)>/g;
const EVENT_ATTR_RE = /\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|\S+)/gi;
const JAVASCRIPT_URL_ATTR_RE = /\s(href|src)\s*=\s*("javascript:[^"]*"|'javascript:[^']*')/gi;
const FILE_EXTENSION_RE = /\.[^.]+$/;
const CSV_NEEDS_QUOTES_RE = /[",\n\r]/;
const DOUBLE_QUOTE_RE = /"/g;
const FORM_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function scalarString(value: unknown, fallback = ""): string {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return fallback;
}

// ── Conditional visibility ──────────────────────────────────────────────────

export function isVisible(field: FieldDef, data: Record<string, unknown>): boolean {
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
			return scalarString(other).includes(scalarString(cond.value));
		case "empty":
			return other == null || other === "" || (Array.isArray(other) && other.length === 0);
		case "notEmpty":
			return other != null && other !== "" && !(Array.isArray(other) && other.length === 0);
	}
}

// ── Field validation ────────────────────────────────────────────────────────

export function validateString(value: string, def: FieldDef): string | null {
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

export function validateField(raw: unknown, def: FieldDef): string | null {
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

	const value = scalarString(raw);
	if (def.required && value.trim() === "") return `${def.label} is required`;
	if (value === "") return null;

	const lengthErr = validateString(value, def);
	if (lengthErr) return lengthErr;

	switch (def.type) {
		case "email":
			if (!EMAIL_RE.test(value)) return `${def.label} must be an email`;
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
			if (!COLOR_HEX_RE.test(value)) return `${def.label} must be a hex colour`;
			break;
		case "select":
		case "radio": {
			const allowed = new Set((def.options ?? []).map((o) => o.value));
			if (!allowed.has(value)) return `${def.label} is not a valid choice`;
			break;
		}
		case "html":
			break;
	}

	return null;
}

export function validateSubmission(
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

// ── HTML sanitiser ──────────────────────────────────────────────────────────

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

export function sanitiseHtml(input: string): string {
	if (!input) return "";
	let out = input;
	out = out.replace(SCRIPT_STYLE_TAG_RE, "");
	out = out.replace(HTML_TAG_RE, (full, tag, attrs) => {
		const lower = String(tag).toLowerCase();
		if (!HTML_ALLOWED_TAGS.has(lower)) return "";
		const cleanedAttrs = String(attrs)
			.replace(EVENT_ATTR_RE, "")
			.replace(JAVASCRIPT_URL_ATTR_RE, "");
		return full.startsWith("</")
			? `</${lower}>`
			: `<${lower}${cleanedAttrs}${attrs.endsWith("/") ? "" : ""}>`;
	});
	return out;
}

// ── File refs helpers ───────────────────────────────────────────────────────

export function normaliseFileRefs(raw: unknown): FileRef[] {
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

export function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
	return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function mimeMatches(mime: string, filename: string, accept: string): boolean {
	const tokens = accept
		.split(",")
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean);
	const lowerMime = mime.toLowerCase();
	const ext = filename.toLowerCase().match(FILE_EXTENSION_RE)?.[0] ?? "";
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

export function csvEscape(s: unknown): string {
	const str = s == null ? "" : typeof s === "object" ? JSON.stringify(s) : scalarString(s);
	if (CSV_NEEDS_QUOTES_RE.test(str)) return `"${str.replace(DOUBLE_QUOTE_RE, '""')}"`;
	return str;
}

export function isValidFormId(id: unknown): id is string {
	return typeof id === "string" && FORM_ID_RE.test(id);
}

export function preprocessForStorage(
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
			out[f.name] = "***";
		}
	}
	return out;
}
