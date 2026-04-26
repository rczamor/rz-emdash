/**
 * Token resolver — pure, dependency-free utility importable by any plugin
 * or by user code.
 *
 * Syntax:
 *
 *   {path}                    — dot-path lookup in the context object
 *   {path|format}             — lookup, then apply a format function
 *   {path|format:arg}         — formatter with one argument
 *   {{literal-braces}}        — escape: emits {literal-braces} unchanged
 *
 * Built-in dynamic paths (resolved without a context entry):
 *
 *   {now}                     — current Date (typically combined with a format)
 *   {uuid}                    — random UUID v4
 *   {timestamp}               — Unix seconds
 *
 * Built-in formatters:
 *
 *   upper, lower, trim
 *   default:fallback          — used when the value is null / undefined / ""
 *   truncate:N                — truncate to N chars + ellipsis
 *   date:FORMAT               — format a Date or ISO string. Tokens: YYYY MM
 *                               DD HH mm ss. e.g. "YYYY-MM-DD"
 *   slug                      — kebab-case ascii slug
 *   json                      — JSON.stringify
 *
 * Custom formatters can be registered per-call via the `formatters` option.
 *
 * Example:
 *
 *   await resolveTokens("Hello {user.name|upper}!", { user: { name: "ada" } })
 *   // → "Hello ADA!"
 *
 *   await resolveTokens("Posted {now|date:YYYY-MM-DD}", {})
 *   // → "Posted 2026-04-25"
 */

export type TokenContext = Record<string, unknown>;

export type Formatter = (value: unknown, arg: string | undefined) => unknown;

export interface ResolveOptions {
	formatters?: Record<string, Formatter>;
	/** What to emit when a path resolves to undefined and no `default:` is given. Defaults to "". */
	missing?: string;
}

const TOKEN_RE = /\{\{|\}\}|\{([^{}]+?)\}/g;

export async function resolveTokens(
	input: string,
	context: TokenContext = {},
	options: ResolveOptions = {},
): Promise<string> {
	if (!input || typeof input !== "string") return input ?? "";
	const formatters = { ...DEFAULT_FORMATTERS, ...(options.formatters ?? {}) };
	const missing = options.missing ?? "";

	return input.replace(TOKEN_RE, (match, expr: string | undefined): string => {
		if (match === "{{") return "{";
		if (match === "}}") return "}";
		if (!expr) return match;

		const [pathPart, ...formatChain] = expr.split("|").map((s) => s.trim());
		let value: unknown = lookupValue(pathPart!, context);

		for (const step of formatChain) {
			const colonIdx = step.indexOf(":");
			const name = colonIdx === -1 ? step : step.slice(0, colonIdx);
			const arg = colonIdx === -1 ? undefined : step.slice(colonIdx + 1);
			const fn = formatters[name];
			if (!fn) continue;
			value = fn(value, arg);
		}

		if (value == null || value === "") return missing;
		return stringifyForOutput(value);
	});
}

function lookupValue(path: string, context: TokenContext): unknown {
	if (path === "now") return new Date();
	if (path === "timestamp") return Math.floor(Date.now() / 1000);
	if (path === "uuid") return generateUuid();

	const parts = path.split(".");
	let current: unknown = context;
	for (const key of parts) {
		if (current == null) return undefined;
		if (typeof current === "object" && key in (current as object)) {
			current = (current as Record<string, unknown>)[key];
		} else {
			return undefined;
		}
	}
	return current;
}

function stringifyForOutput(value: unknown): string {
	if (value instanceof Date) return value.toISOString();
	if (typeof value === "object") return JSON.stringify(value);
	return String(value);
}

function generateUuid(): string {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
		return crypto.randomUUID();
	}
	// Fallback — less random but never used on modern runtimes
	const hex = "0123456789abcdef";
	let out = "";
	for (let i = 0; i < 36; i++) {
		if (i === 8 || i === 13 || i === 18 || i === 23) out += "-";
		else if (i === 14) out += "4";
		else if (i === 19) out += hex[(Math.random() * 4) | (0 + 8)];
		else out += hex[(Math.random() * 16) | 0];
	}
	return out;
}

// ── Built-in formatters ─────────────────────────────────────────────────────

const DEFAULT_FORMATTERS: Record<string, Formatter> = {
	upper: (v) => (v == null ? v : String(v).toUpperCase()),
	lower: (v) => (v == null ? v : String(v).toLowerCase()),
	trim: (v) => (v == null ? v : String(v).trim()),
	default: (v, arg) => (v == null || v === "" ? arg : v),
	truncate: (v, arg) => {
		if (v == null) return v;
		const n = arg ? parseInt(arg, 10) : 100;
		const s = String(v);
		return s.length > n ? s.slice(0, n) + "…" : s;
	},
	date: (v, arg) => {
		const d = v instanceof Date ? v : new Date(String(v));
		if (Number.isNaN(d.getTime())) return v;
		const fmt = arg ?? "YYYY-MM-DD";
		const pad = (n: number, w = 2) => String(n).padStart(w, "0");
		return fmt
			.replace(/YYYY/g, String(d.getUTCFullYear()))
			.replace(/MM/g, pad(d.getUTCMonth() + 1))
			.replace(/DD/g, pad(d.getUTCDate()))
			.replace(/HH/g, pad(d.getUTCHours()))
			.replace(/mm/g, pad(d.getUTCMinutes()))
			.replace(/ss/g, pad(d.getUTCSeconds()));
	},
	slug: (v) => {
		if (v == null) return v;
		return String(v)
			.toLowerCase()
			.normalize("NFKD")
			.replace(/[̀-ͯ]/g, "")
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "");
	},
	json: (v) => JSON.stringify(v),
};

// Re-export so callers can build atop the defaults
export { DEFAULT_FORMATTERS };
