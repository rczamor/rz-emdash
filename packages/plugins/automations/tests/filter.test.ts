import { describe, it, expect } from "vitest";

import { evaluateFilter, lookupPath } from "../src/filter.js";
import type { Filter } from "../src/types.js";

describe("lookupPath", () => {
	it("returns root for $", () => {
		const obj = { a: 1 };
		expect(lookupPath("$", obj)).toBe(obj);
	});

	it("returns top-level value", () => {
		expect(lookupPath("a", { a: 1 })).toBe(1);
	});

	it("traverses nested paths", () => {
		expect(lookupPath("a.b.c", { a: { b: { c: 42 } } })).toBe(42);
	});

	it("returns undefined for missing keys", () => {
		expect(lookupPath("a.missing", { a: {} })).toBeUndefined();
	});

	it("returns undefined when traversing through nullish", () => {
		expect(lookupPath("a.b.c", { a: null })).toBeUndefined();
	});

	it("returns undefined for missing root key", () => {
		expect(lookupPath("nope", { a: 1 })).toBeUndefined();
	});
});

describe("evaluateFilter — primitive operators", () => {
	const event = {
		event: {
			collection: "posts",
			content: {
				featured: true,
				wordCount: 250,
				title: "Hello World",
				tags: ["news", "trending"],
				author: null,
			},
		},
	};

	it("eq matches", () => {
		const f: Filter = { eq: { path: "event.collection", value: "posts" } };
		expect(evaluateFilter(f, event)).toBe(true);
	});

	it("eq distinguishes types (no coercion)", () => {
		const f: Filter = { eq: { path: "event.content.wordCount", value: "250" } };
		expect(evaluateFilter(f, event)).toBe(false);
	});

	it("eq with deep equal on arrays", () => {
		const f: Filter = { eq: { path: "event.content.tags", value: ["news", "trending"] } };
		expect(evaluateFilter(f, event)).toBe(true);
	});

	it("ne returns true for different values", () => {
		const f: Filter = { ne: { path: "event.collection", value: "pages" } };
		expect(evaluateFilter(f, event)).toBe(true);
	});

	it("ne returns false for same values", () => {
		const f: Filter = { ne: { path: "event.collection", value: "posts" } };
		expect(evaluateFilter(f, event)).toBe(false);
	});

	it("in matches one of values", () => {
		const f: Filter = { in: { path: "event.collection", values: ["posts", "pages"] } };
		expect(evaluateFilter(f, event)).toBe(true);
	});

	it("in returns false when none match", () => {
		const f: Filter = { in: { path: "event.collection", values: ["a", "b"] } };
		expect(evaluateFilter(f, event)).toBe(false);
	});

	it("notIn is the inverse of in", () => {
		const f: Filter = { notIn: { path: "event.collection", values: ["a", "b"] } };
		expect(evaluateFilter(f, event)).toBe(true);
	});

	it("contains matches substring", () => {
		const f: Filter = { contains: { path: "event.content.title", value: "World" } };
		expect(evaluateFilter(f, event)).toBe(true);
	});

	it("contains returns false for non-string targets", () => {
		const f: Filter = { contains: { path: "event.content.featured", value: "true" } };
		// false is coerced to "false" by String(...), then "false".includes("true") is false.
		expect(evaluateFilter(f, event)).toBe(false);
	});

	it("matches uses regex", () => {
		const f: Filter = {
			matches: { path: "event.content.title", pattern: "^Hello", flags: "i" },
		};
		expect(evaluateFilter(f, event)).toBe(true);
	});

	it("matches returns false for invalid regex", () => {
		const f: Filter = { matches: { path: "event.content.title", pattern: "[" } };
		expect(evaluateFilter(f, event)).toBe(false);
	});

	it("gt / gte / lt / lte on numbers", () => {
		expect(
			evaluateFilter({ gt: { path: "event.content.wordCount", value: 100 } }, event),
		).toBe(true);
		expect(
			evaluateFilter({ gt: { path: "event.content.wordCount", value: 250 } }, event),
		).toBe(false);
		expect(
			evaluateFilter({ gte: { path: "event.content.wordCount", value: 250 } }, event),
		).toBe(true);
		expect(
			evaluateFilter({ lt: { path: "event.content.wordCount", value: 251 } }, event),
		).toBe(true);
		expect(
			evaluateFilter({ lte: { path: "event.content.wordCount", value: 250 } }, event),
		).toBe(true);
	});

	it("numeric comparators return false on non-number values", () => {
		expect(
			evaluateFilter({ gt: { path: "event.content.title", value: 1 } }, event),
		).toBe(false);
	});

	it("exists returns true for any defined value (including null)", () => {
		expect(evaluateFilter({ exists: { path: "event.content.featured" } }, event)).toBe(true);
		expect(evaluateFilter({ exists: { path: "event.content.author" } }, event)).toBe(true);
	});

	it("exists returns false for undefined", () => {
		expect(evaluateFilter({ exists: { path: "event.content.missing" } }, event)).toBe(false);
	});
});

describe("evaluateFilter — composition", () => {
	const event = {
		event: { collection: "posts", content: { featured: true, wordCount: 100 } },
	};

	it("all returns true when every child matches", () => {
		const f: Filter = {
			all: [
				{ eq: { path: "event.collection", value: "posts" } },
				{ eq: { path: "event.content.featured", value: true } },
			],
		};
		expect(evaluateFilter(f, event)).toBe(true);
	});

	it("all returns false when any child fails", () => {
		const f: Filter = {
			all: [
				{ eq: { path: "event.collection", value: "posts" } },
				{ eq: { path: "event.content.featured", value: false } },
			],
		};
		expect(evaluateFilter(f, event)).toBe(false);
	});

	it("any returns true when at least one child matches", () => {
		const f: Filter = {
			any: [
				{ eq: { path: "event.collection", value: "pages" } },
				{ eq: { path: "event.content.featured", value: true } },
			],
		};
		expect(evaluateFilter(f, event)).toBe(true);
	});

	it("any returns false when all children fail", () => {
		const f: Filter = {
			any: [
				{ eq: { path: "event.collection", value: "x" } },
				{ eq: { path: "event.collection", value: "y" } },
			],
		};
		expect(evaluateFilter(f, event)).toBe(false);
	});

	it("not inverts a child", () => {
		const f: Filter = { not: { eq: { path: "event.collection", value: "pages" } } };
		expect(evaluateFilter(f, event)).toBe(true);
	});

	it("nested composition (all of [any, not])", () => {
		const f: Filter = {
			all: [
				{
					any: [
						{ eq: { path: "event.collection", value: "posts" } },
						{ eq: { path: "event.collection", value: "pages" } },
					],
				},
				{ not: { lt: { path: "event.content.wordCount", value: 50 } } },
			],
		};
		expect(evaluateFilter(f, event)).toBe(true);
	});

	it("empty all-list is vacuously true", () => {
		expect(evaluateFilter({ all: [] }, event)).toBe(true);
	});

	it("empty any-list is vacuously false", () => {
		expect(evaluateFilter({ any: [] }, event)).toBe(false);
	});
});
