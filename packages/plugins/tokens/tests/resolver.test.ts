import { describe, it, expect } from "vitest";

import { resolveTokens } from "../src/resolver.js";

describe("resolveTokens — basic dot-paths", () => {
	it("resolves a simple top-level token", async () => {
		const out = await resolveTokens("Hello {name}", { name: "Ada" });
		expect(out).toBe("Hello Ada");
	});

	it("resolves nested paths", async () => {
		const out = await resolveTokens("{user.name}", { user: { name: "Ada" } });
		expect(out).toBe("Ada");
	});

	it("resolves deeply nested paths", async () => {
		const out = await resolveTokens("{a.b.c.d}", { a: { b: { c: { d: "deep" } } } });
		expect(out).toBe("deep");
	});

	it("returns empty string for missing top-level keys", async () => {
		const out = await resolveTokens("{missing}", {});
		expect(out).toBe("");
	});

	it("returns empty string for missing nested keys", async () => {
		const out = await resolveTokens("{a.missing.thing}", { a: {} });
		expect(out).toBe("");
	});

	it("preserves non-token text verbatim", async () => {
		const out = await resolveTokens("Hello {name}, you are great!", { name: "Ada" });
		expect(out).toBe("Hello Ada, you are great!");
	});

	it("resolves multiple tokens in one string", async () => {
		const out = await resolveTokens("{first} {last}", { first: "Ada", last: "Lovelace" });
		expect(out).toBe("Ada Lovelace");
	});

	it("returns input unchanged when no tokens present", async () => {
		const out = await resolveTokens("just plain text", { unused: "x" });
		expect(out).toBe("just plain text");
	});

	it("returns empty string for empty input", async () => {
		expect(await resolveTokens("", {})).toBe("");
	});
});

describe("resolveTokens — escape syntax", () => {
	it("escapes both braces in a row", async () => {
		expect(await resolveTokens("{{literal}}", {})).toBe("{literal}");
	});

	it("emits literal { for {{ (trailing single } stays literal)", async () => {
		// {{ → {, then "not-a-token}" has no opening brace so it's plain text.
		expect(await resolveTokens("{{not-a-token}", {})).toBe("{not-a-token}");
	});

	it("emits literal } for }} (preceding single { has no closer)", async () => {
		// Mirror — single { has no match and stays literal, then }} → }.
		expect(await resolveTokens("not-a-token}}", {})).toBe("not-a-token}");
	});
});

describe("resolveTokens — dynamic paths", () => {
	it("resolves {now} as a Date", async () => {
		const out = await resolveTokens("{now|date:YYYY-MM-DD}", {});
		expect(out).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});

	it("resolves {timestamp} as Unix seconds", async () => {
		const out = await resolveTokens("{timestamp}", {});
		expect(Number(out)).toBeGreaterThan(1_700_000_000);
	});

	it("resolves {uuid} as a UUID-shaped string", async () => {
		const out = await resolveTokens("{uuid}", {});
		expect(out).toMatch(/^[0-9a-f-]{36}$/i);
	});
});

describe("resolveTokens — built-in formatters", () => {
	it.each<[string, string, Record<string, unknown>, string]>([
		["upper", "{name|upper}", { name: "ada" }, "ADA"],
		["lower", "{name|lower}", { name: "ADA" }, "ada"],
		["trim", "{name|trim}", { name: "  ada  " }, "ada"],
		["default — fallback when missing", "{missing|default:N/A}", {}, "N/A"],
		["default — fallback when empty string", "{name|default:N/A}", { name: "" }, "N/A"],
		["default — present value passes through", "{name|default:N/A}", { name: "Ada" }, "Ada"],
		["truncate — cuts + ellipsis", "{long|truncate:10}", { long: "abcdefghijk" }, "abcdefghij…"],
		["truncate — short input untouched", "{short|truncate:10}", { short: "hi" }, "hi"],
		[
			"truncate — default 100 when arg missing",
			"{long|truncate}",
			{ long: "a".repeat(200) },
			"a".repeat(100) + "…",
		],
		[
			"date — explicit format",
			"{when|date:YYYY-MM-DD}",
			{ when: new Date("2026-04-15T12:00:00Z") },
			"2026-04-15",
		],
		[
			"date — full format tokens",
			"{when|date:YYYY-MM-DD HH:mm:ss}",
			{ when: new Date("2026-04-15T12:34:56Z") },
			"2026-04-15 12:34:56",
		],
		["date — ISO string input", "{when|date:YYYY}", { when: "2026-04-15T00:00:00Z" }, "2026"],
		[
			"date — invalid input passes through",
			"{when|date:YYYY}",
			{ when: "not-a-date" },
			"not-a-date",
		],
		["slug — kebab ascii", "{name|slug}", { name: "Hello World!" }, "hello-world"],
		["slug — strips diacritics", "{name|slug}", { name: "Café Résumé" }, "cafe-resume"],
		["slug — collapses runs", "{name|slug}", { name: "a---b!!!c" }, "a-b-c"],
		["slug — trims edges", "{name|slug}", { name: "---hello---" }, "hello"],
		["json — stringifies object", "{user|json}", { user: { id: 1 } }, '{"id":1}'],
	])("%s", async (_, template, ctx, expected) => {
		expect(await resolveTokens(template, ctx)).toBe(expected);
	});
});

describe("resolveTokens — chained formatters", () => {
	it("chains two formatters left-to-right", async () => {
		expect(await resolveTokens("{name|trim|upper}", { name: "  ada  " })).toBe("ADA");
	});

	it("default + upper composes correctly", async () => {
		expect(await resolveTokens("{missing|default:n/a|upper}", {})).toBe("N/A");
	});
});

describe("resolveTokens — custom formatters", () => {
	it("custom formatter is invoked", async () => {
		const out = await resolveTokens(
			"{n|currency:USD}",
			{ n: 99.95 },
			{
				formatters: {
					currency: (v, code) =>
						new Intl.NumberFormat("en-US", { style: "currency", currency: code ?? "USD" }).format(
							Number(v),
						),
				},
			},
		);
		expect(out).toBe("$99.95");
	});

	it("custom formatter overrides built-in of same name", async () => {
		const out = await resolveTokens(
			"{name|upper}",
			{ name: "ada" },
			{ formatters: { upper: (v) => `*${typeof v === "string" ? v : ""}*` } },
		);
		expect(out).toBe("*ada*");
	});

	it("missing formatter is skipped silently", async () => {
		expect(await resolveTokens("{name|nonexistent}", { name: "Ada" })).toBe("Ada");
	});
});

describe("resolveTokens — value coercion", () => {
	it("coerces numbers to strings", async () => {
		expect(await resolveTokens("{n}", { n: 42 })).toBe("42");
	});

	it("coerces booleans", async () => {
		expect(await resolveTokens("{b}", { b: true })).toBe("true");
	});

	it("Date instances render as ISO strings", async () => {
		const out = await resolveTokens("{when}", { when: new Date("2026-04-15T12:00:00Z") });
		expect(out).toBe("2026-04-15T12:00:00.000Z");
	});

	it("nested object renders as JSON", async () => {
		expect(await resolveTokens("{u}", { u: { id: 1 } })).toBe('{"id":1}');
	});
});

describe("resolveTokens — options", () => {
	it("custom missing-value placeholder", async () => {
		expect(await resolveTokens("{missing}", {}, { missing: "(none)" })).toBe("(none)");
	});

	it("input that's not a string returns empty", async () => {
		// @ts-expect-error — testing runtime behaviour with non-string input
		expect(await resolveTokens(null, {})).toBe("");
	});
});
