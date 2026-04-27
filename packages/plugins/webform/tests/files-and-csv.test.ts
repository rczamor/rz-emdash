import { describe, expect, it } from "vitest";

import { csvEscape, formatBytes, mimeMatches, normaliseFileRefs } from "../src/pure.js";

describe("normaliseFileRefs", () => {
	it("returns [] for nullish", () => {
		expect(normaliseFileRefs(null)).toEqual([]);
		expect(normaliseFileRefs(undefined)).toEqual([]);
	});

	it("wraps single ref", () => {
		const r = { mediaId: "1", filename: "f", mimeType: "text/plain", sizeBytes: 1 };
		expect(normaliseFileRefs(r)).toEqual([r]);
	});

	it("filters out malformed", () => {
		expect(
			normaliseFileRefs([
				{ mediaId: "1" },
				{ filename: "f", mediaId: "2", mimeType: "x", sizeBytes: 1 },
			]),
		).toHaveLength(1);
	});
});

describe("formatBytes", () => {
	it.each([
		[500, "500 B"],
		[2048, "2 KB"],
		[2 * 1024 * 1024, "2.0 MB"],
	])("formatBytes(%i) → %s", (bytes, expected) => {
		expect(formatBytes(bytes)).toBe(expected);
	});
});

describe("mimeMatches", () => {
	it.each<[string, string, string, string, boolean]>([
		["exact mime", "image/png", "x.png", "image/png", true],
		["wildcard match", "image/jpeg", "x.jpg", "image/*", true],
		["wildcard miss", "video/mp4", "x.mp4", "image/*", false],
		["extension match", "application/x", "doc.pdf", ".pdf", true],
		["extension miss", "application/x", "doc.txt", ".pdf", false],
		["comma list", "image/png", "x.png", ".pdf, image/*", true],
	])("%s", (_, mime, name, accept, expected) => {
		expect(mimeMatches(mime, name, accept)).toBe(expected);
	});
});

describe("csvEscape", () => {
	it("plain", () => {
		expect(csvEscape("hello")).toBe("hello");
		expect(csvEscape(null)).toBe("");
	});

	it.each<[string, unknown, string]>([
		["comma", "a,b", '"a,b"'],
		["quote", 'a"b', '"a""b"'],
		["newline", "a\nb", '"a\nb"'],
		["object", { a: 1 }, '"{""a"":1}"'],
	])("%s", (_, input, expected) => {
		expect(csvEscape(input)).toBe(expected);
	});
});
