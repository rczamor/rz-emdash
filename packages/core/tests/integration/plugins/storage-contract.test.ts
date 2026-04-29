/**
 * Storage-contract conformance.
 *
 * Plugins call `ctx.storage.<X>.query({...})` with a `QueryOptions`
 * argument. The supported keys are `where`, `orderBy`, `limit`, and
 * `cursor`. The `filter` alias is supported at runtime for backwards
 * compatibility but is deprecated and must not be introduced in new
 * code.
 *
 * Earlier in this codebase's life, several plugins shipped with
 * `filter:` keys that core silently dropped — submissions, memories,
 * and tasks all leaked across boundaries because the contract wasn't
 * enforced. This test is the boundary: any new `filter:` (or any
 * unknown key) in a `.query(...)` argument fails CI.
 *
 * `count()` takes a `WhereClause` directly (column-name keys), so it
 * is not subject to the QueryOptions key check. We still scan it for
 * the deprecated `filter:` literal in case a copy-pasted shape sneaks
 * in.
 *
 * Implementation: a regex scan over plugin source. Cheaper than a full
 * AST walk, sufficient for the call shape (object literal as the first
 * argument, possibly destructured).
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..", "..");
const PLUGINS_ROOT = join(REPO_ROOT, "packages", "plugins");

/** Recursively list all *.ts files under each plugin's `src/` directory. */
function listPluginSourceFiles(): string[] {
	const out: string[] = [];
	for (const pkg of readdirSync(PLUGINS_ROOT)) {
		const srcDir = join(PLUGINS_ROOT, pkg, "src");
		try {
			if (!statSync(srcDir).isDirectory()) continue;
		} catch {
			continue;
		}
		walk(srcDir, out);
	}
	return out;
}

function walk(dir: string, out: string[]): void {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "node_modules" || entry.name === "dist") continue;
			walk(full, out);
		} else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
			out.push(full);
		}
	}
}

const ALLOWED_QUERY_KEYS = new Set(["where", "orderBy", "limit", "cursor"]);

interface QueryCall {
	file: string;
	line: number;
	method: "query" | "count";
	rawArgs: string;
}

/**
 * Find every `.query({...})` and `.count({...})` call where the immediate
 * argument is an object literal. Returns the argument substring along with
 * file/line metadata.
 */
function findQueryCalls(file: string, src: string): QueryCall[] {
	const out: QueryCall[] = [];
	// Regex for `.method(` followed by anything until `(` close.
	// We then bracket-balance from the opening `{` of an object literal arg.
	const startRe = /\.(query|count)\s*\(\s*\{/g;
	for (const match of src.matchAll(startRe)) {
		const method = match[1] as "query" | "count";
		const matchIndex = match.index ?? 0;
		const argStart = matchIndex + match[0].length - 1; // position of `{`
		const argEnd = matchingBrace(src, argStart);
		if (argEnd === -1) continue;
		const rawArgs = src.slice(argStart, argEnd + 1);
		const line = src.slice(0, matchIndex).split("\n").length;
		out.push({ file, line, method, rawArgs });
	}
	return out;
}

/** Walk forward from an opening `{` and return the index of its matching `}`. */
function matchingBrace(src: string, openIdx: number): number {
	let depth = 0;
	let inString: '"' | "'" | "`" | null = null;
	let inLineComment = false;
	let inBlockComment = false;
	for (let i = openIdx; i < src.length; i++) {
		const c = src[i];
		const next = src[i + 1];
		if (inLineComment) {
			if (c === "\n") inLineComment = false;
			continue;
		}
		if (inBlockComment) {
			if (c === "*" && next === "/") {
				inBlockComment = false;
				i++;
			}
			continue;
		}
		if (inString) {
			if (c === "\\") {
				i++;
				continue;
			}
			if (c === inString) inString = null;
			continue;
		}
		if (c === "/" && next === "/") {
			inLineComment = true;
			i++;
			continue;
		}
		if (c === "/" && next === "*") {
			inBlockComment = true;
			i++;
			continue;
		}
		if (c === '"' || c === "'" || c === "`") {
			inString = c;
			continue;
		}
		if (c === "{") depth++;
		else if (c === "}") {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

/**
 * Extract the top-level keys of an object literal substring `{ ... }`.
 * Skips spread elements, computed keys, and nested object/string content.
 * Conservative: returns a superset of likely keys; false positives mean
 * stricter (more failing) behavior, which is acceptable for a contract test.
 */
function extractTopLevelKeys(literal: string): string[] {
	if (!literal.startsWith("{") || !literal.endsWith("}")) return [];
	const inner = literal.slice(1, -1);

	let depth = 0;
	let inString: '"' | "'" | "`" | null = null;
	let inLineComment = false;
	let inBlockComment = false;
	let segStart = 0;
	const segments: string[] = [];

	for (let i = 0; i < inner.length; i++) {
		const c = inner[i];
		const next = inner[i + 1];
		if (inLineComment) {
			if (c === "\n") inLineComment = false;
			continue;
		}
		if (inBlockComment) {
			if (c === "*" && next === "/") {
				inBlockComment = false;
				i++;
			}
			continue;
		}
		if (inString) {
			if (c === "\\") {
				i++;
				continue;
			}
			if (c === inString) inString = null;
			continue;
		}
		if (c === "/" && next === "/") {
			inLineComment = true;
			i++;
			continue;
		}
		if (c === "/" && next === "*") {
			inBlockComment = true;
			i++;
			continue;
		}
		if (c === '"' || c === "'" || c === "`") {
			inString = c;
			continue;
		}
		if (c === "{" || c === "[" || c === "(") depth++;
		else if (c === "}" || c === "]" || c === ")") depth--;
		else if (c === "," && depth === 0) {
			segments.push(inner.slice(segStart, i));
			segStart = i + 1;
		}
	}
	segments.push(inner.slice(segStart));

	const keys: string[] = [];
	for (const seg of segments) {
		const trimmed = seg.trim();
		if (!trimmed) continue;
		if (trimmed.startsWith("...")) continue; // spread
		// Match identifier or string-literal key followed by `:`
		const keyMatch = /^(?:["'`]([^"'`]+)["'`]|([A-Za-z_$][\w$]*))\s*:/.exec(trimmed);
		if (keyMatch) {
			keys.push(keyMatch[1] ?? keyMatch[2] ?? "");
		}
	}
	return keys.filter(Boolean);
}

describe("plugin storage contract", () => {
	it("storage query/count calls do not use the deprecated `filter` key, and query() uses only QueryOptions keys", () => {
		const files = listPluginSourceFiles();
		const violations: string[] = [];

		for (const abs of files) {
			const rel = abs.slice(REPO_ROOT.length + 1);
			const src = readFileSync(abs, "utf8");
			const calls = findQueryCalls(rel, src);
			for (const call of calls) {
				const keys = extractTopLevelKeys(call.rawArgs);
				// `filter:` is the deprecated alias — never allowed in new code,
				// regardless of method.
				if (keys.includes("filter")) {
					violations.push(`${call.file}:${call.line} — .${call.method}({ filter: ... })`);
				}
				// `query()` takes QueryOptions; enforce the key allowlist.
				// `count()` takes a WhereClause directly — keys are column
				// names, not QueryOptions keys, so skip the allowlist.
				if (call.method === "query") {
					for (const k of keys) {
						if (!ALLOWED_QUERY_KEYS.has(k)) {
							violations.push(`${call.file}:${call.line} — unknown key '${k}' in .query(...)`);
						}
					}
				}
			}
		}

		if (violations.length > 0) {
			throw new Error(
				`Storage contract violations:\n${violations.join("\n")}\n\n` +
					`Use { where: ... } not { filter: ... }. See QueryOptions in packages/core/src/plugins/types.ts.`,
			);
		}
	});

	it("at least one plugin actually uses the storage query API (sanity)", () => {
		const files = listPluginSourceFiles();
		let totalCalls = 0;
		for (const abs of files) {
			const rel = abs.slice(REPO_ROOT.length + 1);
			const src = readFileSync(abs, "utf8");
			totalCalls += findQueryCalls(rel, src).length;
		}
		// If this drops to 0 the regex broke, not the plugins.
		expect(totalCalls).toBeGreaterThan(20);
	});
});
