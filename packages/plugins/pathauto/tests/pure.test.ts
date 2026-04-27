import { describe, expect, it } from "vitest";

import {
	applyPatternPure,
	isValidCollectionName,
	SEPARATOR_BREAKPOINT_RATIO,
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
	// With maxLength = 20, the breakpoint is 20 * 0.7 = 14. A separator must
	// land at index > 14 within the cut window for trimSlug to keep it.
	const max = 20;
	const breakpoint = max * SEPARATOR_BREAKPOINT_RATIO;

	it("returns slug unchanged when within limit", () => {
		expect(trimSlug("hello", max)).toBe("hello");
	});

	it("hard-cuts when no separator falls past the breakpoint", () => {
		// "-" lands at index 5 (well below the 14 breakpoint) → hard cut at 20.
		const slug = "abcd-efghijklmnopqrstuvwxyz";
		const out = trimSlug(slug, max);
		expect(out).toBe(slug.slice(0, max));
		expect(out.lastIndexOf("-")).toBeLessThanOrEqual(breakpoint);
	});

	it("keeps the trailing separator when it falls past the breakpoint", () => {
		// "-" lands at index 18 (> 14 breakpoint) → cut there, drop the tail.
		expect(trimSlug("hello-world-foobar-baz", max)).toBe("hello-world-foobar");
	});

	it("respects `/` as a separator", () => {
		// "/" lands at index 17 (> 14 breakpoint) → cut there.
		expect(trimSlug("aa/bb/cc/dd/eeeee/extra", max)).toBe("aa/bb/cc/dd/eeeee");
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
		const slug = await applyPatternPure({ collection: "posts", pattern: "{content.missing}" }, {});
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
