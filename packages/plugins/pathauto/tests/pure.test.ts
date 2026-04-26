import { describe, it, expect } from "vitest";

import {
	applyPatternPure,
	isValidCollectionName,
	slugifySegment,
	trimSlug,
} from "../src/pure.js";

describe("isValidCollectionName", () => {
	it("accepts valid names", () => {
		expect(isValidCollectionName("posts")).toBe(true);
		expect(isValidCollectionName("blog-posts")).toBe(true);
		expect(isValidCollectionName("a_b")).toBe(true);
		expect(isValidCollectionName("a")).toBe(true);
	});

	it("rejects invalid", () => {
		expect(isValidCollectionName("")).toBe(false);
		expect(isValidCollectionName("Posts")).toBe(false);
		expect(isValidCollectionName("-bad")).toBe(false);
		expect(isValidCollectionName("a".repeat(65))).toBe(false);
		expect(isValidCollectionName(123)).toBe(false);
		expect(isValidCollectionName(null)).toBe(false);
	});
});

describe("trimSlug", () => {
	it("returns slug unchanged when within limit", () => {
		expect(trimSlug("hello", 10)).toBe("hello");
	});

	it("hard-cuts when no separator near boundary", () => {
		expect(trimSlug("abcdefghijklmnop", 5)).toBe("abcde");
	});

	it("cuts at last separator if near boundary", () => {
		// maxLength 20, breakpoint 14; last "-" should be retained if > 14
		expect(trimSlug("hello-world-foobar-baz", 20)).toBe("hello-world-foobar");
	});

	it("breaks at slash", () => {
		// max 10, breakpoint 7; "/" at 7 satisfies > 7? not strictly, so hard cut applies.
		// Use a case where the separator is past the 70% mark.
		expect(trimSlug("ab/cd/efghij", 10)).toBe("ab/cd/efgh");
		expect(trimSlug("aa/bb/cc/dd-extra", 12)).toBe("aa/bb/cc/dd");
	});
});

describe("slugifySegment", () => {
	it("converts spaces to hyphens", () => {
		expect(slugifySegment("Hello World")).toBe("Hello-World");
	});

	it("strips non-alphanumeric", () => {
		expect(slugifySegment("Foo!@#Bar")).toBe("Foo-Bar");
	});

	it("trims leading/trailing hyphens", () => {
		expect(slugifySegment("--foo--")).toBe("foo");
	});

	it("collapses runs", () => {
		expect(slugifySegment("a   b")).toBe("a-b");
	});
});

describe("applyPatternPure", () => {
	it("substitutes single token", async () => {
		const slug = await applyPatternPure(
			{ collection: "posts", pattern: "{content.title}" },
			{ title: "Hello World" },
		);
		expect(slug).toBe("hello-world");
	});

	it("preserves slashes between segments", async () => {
		const slug = await applyPatternPure(
			{ collection: "posts", pattern: "{content.category}/{content.title}" },
			{ category: "News", title: "Big Announcement" },
		);
		expect(slug).toBe("news/big-announcement");
	});

	it("respects lowercase=false", async () => {
		const slug = await applyPatternPure(
			{ collection: "posts", pattern: "{content.title}", lowercase: false },
			{ title: "Hello" },
		);
		expect(slug).toBe("Hello");
	});

	it("respects maxLength", async () => {
		const slug = await applyPatternPure(
			{ collection: "posts", pattern: "{content.title}", maxLength: 5 },
			{ title: "abcdefghij" },
		);
		expect(slug?.length).toBeLessThanOrEqual(5);
	});

	it("returns null when pattern resolves to empty", async () => {
		const slug = await applyPatternPure(
			{ collection: "posts", pattern: "{content.missing}" },
			{},
		);
		expect(slug).toBeNull();
	});

	it("filters empty segments", async () => {
		const slug = await applyPatternPure(
			{ collection: "posts", pattern: "{content.a}/{content.b}/{content.c}" },
			{ a: "x", b: "", c: "z" },
		);
		expect(slug).toBe("x/z");
	});
});
