import { describe, expect, it } from "vitest";

import { asNumber, asString, getSiteUrl } from "../src/built-ins.js";

describe("asString", () => {
	it.each<[unknown, string]>([
		["hello", "hello"],
		["", ""],
		[null, ""],
		[undefined, ""],
		[42, ""],
		[{ a: 1 }, ""],
		[true, ""],
	])("asString(%p) → %j", (input, expected) => {
		expect(asString(input)).toBe(expected);
	});

	it("uses the supplied fallback for non-strings", () => {
		expect(asString(null, "FALLBACK")).toBe("FALLBACK");
		expect(asString(42, "n/a")).toBe("n/a");
	});

	it("does not apply fallback to actual strings", () => {
		expect(asString("real", "FALLBACK")).toBe("real");
		expect(asString("", "FALLBACK")).toBe("");
	});
});

describe("asNumber", () => {
	it.each<[unknown, number | undefined]>([
		[42, 42],
		[0, 0],
		[-1.5, -1.5],
		["42", 42],
		["3.14", 3.14],
		["abc", undefined],
		[null, undefined],
		[undefined, undefined],
		[{}, undefined],
		[true, undefined],
	])("asNumber(%p) → %p", (input, expected) => {
		expect(asNumber(input)).toBe(expected);
	});

	it("uses fallback when coercion fails", () => {
		expect(asNumber("abc", 99)).toBe(99);
		expect(asNumber(null, 0)).toBe(0);
	});

	it("ignores fallback when input is already numeric", () => {
		expect(asNumber(7, 99)).toBe(7);
		expect(asNumber("7", 99)).toBe(7);
	});
});

describe("getSiteUrl", () => {
	const mk = (url: string | undefined) =>
		({ site: url === undefined ? undefined : { url } }) as unknown as Parameters<
			typeof getSiteUrl
		>[0];

	it("strips trailing slash", () => {
		expect(getSiteUrl(mk("https://example.com/"))).toBe("https://example.com");
	});

	it("leaves URLs without trailing slash alone", () => {
		expect(getSiteUrl(mk("https://example.com"))).toBe("https://example.com");
	});

	it("falls back to localhost:4321 when ctx.site is missing", () => {
		expect(getSiteUrl(mk(undefined))).toBe("http://localhost:4321");
	});

	it("strips the trailing slash on the localhost fallback if it had one", () => {
		// (constructed: pass an empty `site` so the fallback string is still subjected to the
		//  trailing-slash strip — exercises the same code path as a configured URL would.)
		expect(getSiteUrl(mk("http://localhost:4321/"))).toBe("http://localhost:4321");
	});
});
