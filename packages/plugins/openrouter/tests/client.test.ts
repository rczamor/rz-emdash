import { describe, expect, it } from "vitest";

import { authHeaders, extractText } from "../src/client.js";
import type { ChatCompletionResponse } from "../src/client.js";

describe("authHeaders", () => {
	it("emits Bearer + Content-Type when only apiKey is set", () => {
		expect(authHeaders({ apiKey: "k" })).toEqual({
			Authorization: "Bearer k",
			"Content-Type": "application/json",
		});
	});

	it("adds HTTP-Referer when siteUrl is set", () => {
		const out = authHeaders({ apiKey: "k", siteUrl: "https://emdash.dev" });
		expect(out["HTTP-Referer"]).toBe("https://emdash.dev");
	});

	it("adds X-Title when siteName is set", () => {
		const out = authHeaders({ apiKey: "k", siteName: "EmDash" });
		expect(out["X-Title"]).toBe("EmDash");
	});

	it("emits all four headers when every config field is set", () => {
		const out = authHeaders({ apiKey: "k", siteUrl: "https://x", siteName: "X" });
		expect(Object.keys(out).toSorted()).toEqual(
			["Authorization", "Content-Type", "HTTP-Referer", "X-Title"].toSorted(),
		);
	});

	it("omits HTTP-Referer / X-Title when fields are empty strings", () => {
		const out = authHeaders({ apiKey: "k", siteUrl: "", siteName: "" });
		expect(out["HTTP-Referer"]).toBeUndefined();
		expect(out["X-Title"]).toBeUndefined();
	});
});

describe("extractText", () => {
	const wrap = (content: string | null): ChatCompletionResponse => ({
		id: "x",
		choices: [
			{
				index: 0,
				message: { role: "assistant", content: content as string },
				finish_reason: "stop",
			},
		],
	});

	it("returns the assistant content", () => {
		expect(extractText(wrap("hello"))).toBe("hello");
	});

	it("returns '' on empty content", () => {
		expect(extractText(wrap(""))).toBe("");
	});

	it("returns '' when content is null", () => {
		expect(extractText(wrap(null))).toBe("");
	});

	it("returns '' when choices is empty", () => {
		expect(extractText({ id: "x", choices: [] })).toBe("");
	});
});
