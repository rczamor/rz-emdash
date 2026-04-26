/**
 * DESIGN.md parser + validator + token resolver.
 *
 * Pure functions — no I/O. Imports the `yaml` library for frontmatter.
 * Body parsing is regex-based: split on `^## ` headings.
 */

import { parse as parseYaml } from "yaml";

import type {
	DesignSystemFrontmatter,
	DesignSystemSection,
	ParsedDesignSystem,
	ResolvedTokens,
	ValidationFinding,
	ValidationReport,
} from "./types.js";

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?/;
const SECTION_HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/gm;
const TOKEN_REF_RE = /\{([a-zA-Z][a-zA-Z0-9_.-]*)\}/g;

const KNOWN_SECTIONS = [
	"overview",
	"colors",
	"typography",
	"layout",
	"elevation",
	"elevation & depth",
	"shapes",
	"components",
	"do's and don'ts",
	"dos and donts",
	"do and don't",
];

export function parseDesignSystem(source: string): ParsedDesignSystem {
	const fmMatch = source.match(FRONTMATTER_RE);
	let frontmatter: DesignSystemFrontmatter = {};
	let bodyOffset = 0;
	if (fmMatch) {
		try {
			const fm = parseYaml(fmMatch[1]!);
			if (fm && typeof fm === "object") {
				frontmatter = fm as DesignSystemFrontmatter;
			}
		} catch {
			// Frontmatter parse error — leave as empty; validate() will report.
		}
		bodyOffset = fmMatch[0]!.length;
	}
	const bodyMarkdown = source.slice(bodyOffset);

	const sections = extractSections(bodyMarkdown);

	return {
		frontmatter,
		sections,
		bodyMarkdown,
		rawSource: source,
		parsedAt: new Date().toISOString(),
	};
}

function extractSections(body: string): DesignSystemSection[] {
	const lines = body.split("\n");
	const sections: DesignSystemSection[] = [];
	let current: DesignSystemSection | null = null;
	for (const line of lines) {
		const m = line.match(/^(#{1,6})\s+(.+?)\s*$/);
		if (m) {
			if (current) sections.push(current);
			current = {
				heading: m[2]!,
				level: m[1]!.length,
				body: "",
			};
		} else if (current) {
			current.body += (current.body ? "\n" : "") + line;
		}
	}
	if (current) sections.push(current);
	return sections.map((s) => ({ ...s, body: s.body.trim() }));
}

// ── Validation ──────────────────────────────────────────────────────────────

export function validateDesignSystem(parsed: ParsedDesignSystem): ValidationReport {
	const findings: ValidationFinding[] = [];

	// Spec rule: reject duplicate top-level (level 2) section headings.
	const headingCounts = new Map<string, number>();
	for (const s of parsed.sections) {
		if (s.level === 2) {
			const key = s.heading.trim().toLowerCase();
			headingCounts.set(key, (headingCounts.get(key) ?? 0) + 1);
		}
	}
	for (const [heading, count] of headingCounts) {
		if (count > 1) {
			findings.push({
				level: "error",
				code: "duplicate-section",
				message: `Duplicate section heading "${heading}" (${count}× — spec rejects duplicates)`,
				location: heading,
			});
		}
	}

	// Required: name is recommended but not strictly required by spec.
	if (!parsed.frontmatter.name) {
		findings.push({
			level: "warning",
			code: "missing-name",
			message: "Frontmatter is missing a `name` field — agents won't know what to call the system",
		});
	}

	// Detect broken token references in the body.
	const flatTokens = flattenFrontmatter(parsed.frontmatter);
	for (const m of parsed.bodyMarkdown.matchAll(TOKEN_REF_RE)) {
		const ref = m[1]!;
		if (!flatTokens.has(ref)) {
			findings.push({
				level: "warning",
				code: "broken-token-ref",
				message: `Body references unknown token "{${ref}}"`,
				location: ref,
			});
		}
	}

	// WCAG contrast for text colors (best-effort: scan colors prefixed with text/foreground/onX).
	const contrastFindings = wcagContrastChecks(parsed.frontmatter);
	findings.push(...contrastFindings);

	// Info: unknown body sections are allowed by spec, but flag for visibility.
	for (const s of parsed.sections.filter((x) => x.level === 2)) {
		if (!KNOWN_SECTIONS.includes(s.heading.trim().toLowerCase())) {
			findings.push({
				level: "info",
				code: "unknown-section",
				message: `Unknown section "${s.heading}" — accepted by spec, but consumers won't recognise it`,
				location: s.heading,
			});
		}
	}

	const ok = !findings.some((f) => f.level === "error");
	return { ok, findings };
}

// ── Token resolution ───────────────────────────────────────────────────────

function flattenFrontmatter(fm: DesignSystemFrontmatter, prefix = ""): Map<string, string> {
	const out = new Map<string, string>();
	for (const [key, value] of Object.entries(fm)) {
		const path = prefix ? `${prefix}.${key}` : key;
		if (value == null) continue;
		if (typeof value === "string" || typeof value === "number") {
			out.set(path, String(value));
		} else if (typeof value === "object" && !Array.isArray(value)) {
			const obj = value as Record<string, unknown>;
			if ("value" in obj && typeof obj.value === "string") {
				out.set(path, obj.value);
			}
			for (const [k, v] of flattenFrontmatter(obj as DesignSystemFrontmatter, path)) {
				out.set(k, v);
			}
		}
	}
	return out;
}

export function resolveTokens(fm: DesignSystemFrontmatter): {
	resolved: ResolvedTokens;
	unresolved: string[];
} {
	const flat = flattenFrontmatter(fm);
	const unresolved: string[] = [];

	function resolveStr(s: string): string {
		return s.replace(TOKEN_REF_RE, (whole, ref) => {
			const value = flat.get(ref);
			if (value == null) {
				unresolved.push(ref);
				return whole;
			}
			return String(value);
		});
	}

	function walk(value: unknown): unknown {
		if (typeof value === "string") return resolveStr(value);
		if (Array.isArray(value)) return value.map(walk);
		if (value && typeof value === "object") {
			const out: Record<string, unknown> = {};
			for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
				out[k] = walk(v);
			}
			return out;
		}
		return value;
	}

	return {
		resolved: walk(fm) as ResolvedTokens,
		unresolved,
	};
}

// ── WCAG contrast (best-effort) ─────────────────────────────────────────────

function hexToRgb(hex: string): [number, number, number] | null {
	const cleaned = hex.replace(/^#/, "");
	if (cleaned.length === 3) {
		const r = parseInt(cleaned[0]! + cleaned[0], 16);
		const g = parseInt(cleaned[1]! + cleaned[1], 16);
		const b = parseInt(cleaned[2]! + cleaned[2], 16);
		if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return null;
		return [r, g, b];
	}
	if (cleaned.length === 6) {
		const r = parseInt(cleaned.slice(0, 2), 16);
		const g = parseInt(cleaned.slice(2, 4), 16);
		const b = parseInt(cleaned.slice(4, 6), 16);
		if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return null;
		return [r, g, b];
	}
	return null;
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
	const channel = (c: number) => {
		const sRGB = c / 255;
		return sRGB <= 0.03928 ? sRGB / 12.92 : Math.pow((sRGB + 0.055) / 1.055, 2.4);
	};
	const [R, G, B] = [channel(r), channel(g), channel(b)];
	return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}

export function contrastRatio(fg: string, bg: string): number | null {
	const a = hexToRgb(fg);
	const b = hexToRgb(bg);
	if (!a || !b) return null;
	const la = relativeLuminance(a);
	const lb = relativeLuminance(b);
	const lighter = Math.max(la, lb);
	const darker = Math.min(la, lb);
	return (lighter + 0.05) / (darker + 0.05);
}

function wcagContrastChecks(fm: DesignSystemFrontmatter): ValidationFinding[] {
	const findings: ValidationFinding[] = [];
	const colors = fm.colors ?? {};
	const flat: Record<string, string> = {};
	for (const [name, value] of Object.entries(colors)) {
		const v = typeof value === "string" ? value : value.value;
		if (typeof v === "string") flat[name] = v;
	}

	// Pair text-like keys against background-like keys
	const textKeys = Object.keys(flat).filter((k) =>
		/^(text|foreground|fg|on(Background|Surface|Primary|Secondary)?)/i.test(k),
	);
	const bgKeys = Object.keys(flat).filter((k) =>
		/^(background|bg|surface|primary|secondary)$/i.test(k),
	);

	for (const tk of textKeys) {
		for (const bk of bgKeys) {
			const ratio = contrastRatio(flat[tk]!, flat[bk]!);
			if (ratio == null) continue;
			if (ratio < 4.5) {
				findings.push({
					level: ratio < 3 ? "error" : "warning",
					code: "wcag-contrast",
					message: `${tk} on ${bk}: contrast ${ratio.toFixed(2)} (WCAG AA wants ≥4.5)`,
					location: `${tk} / ${bk}`,
				});
			}
		}
	}
	return findings;
}

// ── Tailwind export ─────────────────────────────────────────────────────────

export function exportTailwindConfig(fm: DesignSystemFrontmatter): Record<string, unknown> {
	const colors: Record<string, string> = {};
	for (const [name, value] of Object.entries(fm.colors ?? {})) {
		const v = typeof value === "string" ? value : value.value;
		if (typeof v === "string") colors[name] = v;
	}

	const fontSize: Record<string, string> = {};
	const fontFamily: Record<string, string[]> = {};
	for (const [name, value] of Object.entries(fm.typography ?? {})) {
		const tk = typeof value === "string" ? { fontSize: value } : value;
		if (tk.fontFamily) {
			fontFamily[name] = String(tk.fontFamily)
				.split(",")
				.map((s) => s.trim());
		}
		if (tk.fontSize) {
			fontSize[name] = String(tk.fontSize);
		}
	}

	const spacing = { ...(fm.spacing ?? {}) };
	const borderRadius = { ...(fm.rounded ?? {}) };

	return {
		theme: {
			extend: {
				colors,
				fontFamily,
				fontSize,
				spacing,
				borderRadius,
			},
		},
	};
}

// ── Prompt-injection assembler ──────────────────────────────────────────────

export function assembleDesignSystemBlock(parsed: ParsedDesignSystem): string {
	const fm = parsed.frontmatter;
	const lines: string[] = [];
	lines.push(`# Design system${fm.name ? `: ${fm.name}` : ""}`);
	if (fm.description) lines.push(`\n${fm.description.trim()}`);

	if (fm.colors) {
		lines.push(`\n## Colors\n`);
		for (const [name, value] of Object.entries(fm.colors)) {
			const v = typeof value === "string" ? value : value.value;
			const desc = typeof value === "object" && value.description ? ` — ${value.description}` : "";
			lines.push(`- **${name}**: ${v}${desc}`);
		}
	}

	if (fm.typography) {
		lines.push(`\n## Typography\n`);
		for (const [name, value] of Object.entries(fm.typography)) {
			if (typeof value === "string") {
				lines.push(`- **${name}**: ${value}`);
			} else {
				const parts = [
					value.fontFamily && `family: ${value.fontFamily}`,
					value.fontSize && `size: ${value.fontSize}`,
					value.fontWeight && `weight: ${value.fontWeight}`,
					value.lineHeight && `line-height: ${value.lineHeight}`,
				].filter(Boolean);
				lines.push(`- **${name}**: ${parts.join(", ")}`);
			}
		}
	}

	if (fm.spacing) {
		lines.push(`\n## Spacing\n`);
		for (const [k, v] of Object.entries(fm.spacing)) lines.push(`- ${k}: ${v}`);
	}

	if (fm.rounded) {
		lines.push(`\n## Corner radii\n`);
		for (const [k, v] of Object.entries(fm.rounded)) lines.push(`- ${k}: ${v}`);
	}

	const dosDonts = parsed.sections.find((s) =>
		/do(?:es|'s)?\s*and\s*don'?ts?/i.test(s.heading),
	);
	if (dosDonts) {
		lines.push(`\n## Do's and Don'ts\n\n${dosDonts.body}`);
	}

	return lines.join("\n");
}
