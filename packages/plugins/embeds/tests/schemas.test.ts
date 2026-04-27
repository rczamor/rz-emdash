import { describe, expect, it } from "vitest";

import {
	blueskyBlockSchema,
	embedBlockSchema,
	EMBED_BLOCK_TYPES,
	gistBlockSchema,
	linkPreviewBlockSchema,
	tweetBlockSchema,
	vimeoBlockSchema,
	youtubeBlockSchema,
} from "../src/schemas.js";

describe("httpUrl SSRF/XSS rejection (via linkPreviewBlockSchema.id)", () => {
	const ok = (id: string) =>
		linkPreviewBlockSchema.safeParse({ _type: "linkPreview", _key: "k", id });

	it.each([
		["https URL", "https://example.com/post", true],
		["http URL", "http://example.com/post", true],
		["http with port", "http://example.com:8080/x", true],
		["javascript: scheme", "javascript:alert(1)", false],
		["data: URI", "data:text/html,<script>alert(1)</script>", false],
		["file: scheme", "file:///etc/passwd", false],
		["ftp: scheme", "ftp://example.com", false],
		["bare hostname (no scheme)", "example.com", false],
		["malformed", "not a url", false],
	])("%s → %s", (_, id, expected) => {
		expect(ok(id).success).toBe(expected);
	});
});

describe("youtubeBlockSchema", () => {
	it("accepts a minimal block", () => {
		const r = youtubeBlockSchema.safeParse({ _type: "youtube", _key: "k", id: "dQw4w9WgXcQ" });
		expect(r.success).toBe(true);
	});

	it("accepts all optional fields", () => {
		const r = youtubeBlockSchema.safeParse({
			_type: "youtube",
			_key: "k",
			id: "x",
			poster: "https://img.example.com/p.jpg",
			posterQuality: "max",
			params: "start=10",
			playlabel: "Play",
			title: "Demo",
		});
		expect(r.success).toBe(true);
	});

	it("rejects unknown posterQuality", () => {
		const r = youtubeBlockSchema.safeParse({
			_type: "youtube",
			_key: "k",
			id: "x",
			posterQuality: "ultra",
		});
		expect(r.success).toBe(false);
	});

	it("rejects javascript: poster URL", () => {
		const r = youtubeBlockSchema.safeParse({
			_type: "youtube",
			_key: "k",
			id: "x",
			poster: "javascript:alert(1)",
		});
		expect(r.success).toBe(false);
	});

	it("rejects missing required id", () => {
		expect(youtubeBlockSchema.safeParse({ _type: "youtube", _key: "k" }).success).toBe(false);
	});
});

describe("simple-id schemas (vimeo / tweet / bluesky / mastodon)", () => {
	it.each([
		[vimeoBlockSchema, "vimeo"],
		[tweetBlockSchema, "tweet"],
		[blueskyBlockSchema, "bluesky"],
	])("%s accepts minimal block", (schema, _type) => {
		expect(schema.safeParse({ _type, _key: "k", id: "x" }).success).toBe(true);
	});

	it("tweetBlockSchema accepts theme enum", () => {
		expect(
			tweetBlockSchema.safeParse({ _type: "tweet", _key: "k", id: "1", theme: "dark" }).success,
		).toBe(true);
	});

	it("tweetBlockSchema rejects unknown theme", () => {
		expect(
			tweetBlockSchema.safeParse({ _type: "tweet", _key: "k", id: "1", theme: "neon" }).success,
		).toBe(false);
	});
});

describe("gistBlockSchema", () => {
	it("requires the id to be an http(s) URL", () => {
		expect(
			gistBlockSchema.safeParse({
				_type: "gist",
				_key: "k",
				id: "https://gist.github.com/u/abc",
			}).success,
		).toBe(true);
		expect(gistBlockSchema.safeParse({ _type: "gist", _key: "k", id: "abc" }).success).toBe(false);
	});

	it("accepts an optional file selector", () => {
		expect(
			gistBlockSchema.safeParse({
				_type: "gist",
				_key: "k",
				id: "https://gist.github.com/u/abc",
				file: "main.ts",
			}).success,
		).toBe(true);
	});
});

describe("embedBlockSchema discriminated union", () => {
	it("dispatches on _type", () => {
		const r = embedBlockSchema.safeParse({ _type: "tweet", _key: "k", id: "1" });
		expect(r.success).toBe(true);
		if (r.success) expect(r.data._type).toBe("tweet");
	});

	it("rejects an unknown _type", () => {
		expect(embedBlockSchema.safeParse({ _type: "tiktok", _key: "k", id: "1" }).success).toBe(false);
	});

	it("rejects a block missing required field on its branch", () => {
		expect(embedBlockSchema.safeParse({ _type: "youtube", _key: "k" /* no id */ }).success).toBe(
			false,
		);
	});
});

describe("EMBED_BLOCK_TYPES", () => {
	it("matches all defined schemas", () => {
		expect(EMBED_BLOCK_TYPES.toSorted()).toEqual(
			["bluesky", "gist", "linkPreview", "mastodon", "tweet", "vimeo", "youtube"].toSorted(),
		);
	});
});
