import type { PluginContext } from "emdash";
import { beforeEach, describe, expect, it } from "vitest";

import {
	_resetValidators,
	listValidators,
	registerValidator,
	runValidators,
	type Validator,
} from "../src/validators.js";
import { registerDefaultValidators } from "../src/default-validators.js";

beforeEach(() => {
	_resetValidators();
});

const fakeCtx = {} as PluginContext;

describe("validators registry", () => {
	it("registers and lists validators sorted by id", () => {
		registerValidator({
			id: "z",
			name: "Z",
			run: async () => [],
		});
		registerValidator({
			id: "a",
			name: "A",
			run: async () => [],
		});
		expect(listValidators().map((v) => v.id)).toEqual(["a", "z"]);
	});

	it("re-registering by same id replaces the validator", () => {
		const first: Validator = { id: "x", name: "First", run: async () => [] };
		const second: Validator = { id: "x", name: "Second", run: async () => [] };
		registerValidator(first);
		registerValidator(second);
		const listed = listValidators();
		expect(listed).toHaveLength(1);
		expect(listed[0]?.name).toBe("Second");
	});
});

describe("runValidators", () => {
	it("aggregates findings from every validator", async () => {
		registerValidator({
			id: "a",
			name: "A",
			run: async () => [{ severity: "warn", source: "a", message: "warn-from-a" }],
		});
		registerValidator({
			id: "b",
			name: "B",
			run: async () => [{ severity: "fail", source: "b", message: "fail-from-b" }],
		});
		const report = await runValidators({
			collection: "posts",
			id: null,
			data: {},
			plugin: fakeCtx,
		});
		expect(report.ok).toBe(false);
		expect(report.findings).toHaveLength(2);
		expect(report.findings.map((f) => f.source).sort()).toEqual(["a", "b"]);
	});

	it("returns ok:true when all findings are warn or pass", async () => {
		registerValidator({
			id: "ok-only",
			name: "OK",
			run: async () => [{ severity: "warn", source: "x", message: "x" }],
		});
		const report = await runValidators({ collection: "posts", id: null, data: {}, plugin: fakeCtx });
		expect(report.ok).toBe(true);
	});

	it("a validator that throws produces a warn finding (does not block)", async () => {
		registerValidator({
			id: "boom",
			name: "Boom",
			run: async () => {
				throw new Error("validator died");
			},
		});
		const report = await runValidators({ collection: "posts", id: null, data: {}, plugin: fakeCtx });
		expect(report.ok).toBe(true);
		expect(report.findings[0]?.severity).toBe("warn");
		expect(report.findings[0]?.message).toMatch(/threw.*validator died/);
	});

	it("returns ok:true with no findings when no validators registered", async () => {
		const report = await runValidators({ collection: "posts", id: null, data: {}, plugin: fakeCtx });
		expect(report.ok).toBe(true);
		expect(report.findings).toEqual([]);
	});
});

describe("default seo validator", () => {
	beforeEach(() => {
		_resetValidators();
		registerDefaultValidators();
	});

	it("flags missing title as fail", async () => {
		const report = await runValidators({
			collection: "posts",
			id: null,
			data: { description: "x", body: "x" },
			plugin: fakeCtx,
		});
		expect(report.ok).toBe(false);
		expect(report.findings.some((f) => f.severity === "fail" && /title/i.test(f.message))).toBe(true);
	});

	it("warns on out-of-range title length", async () => {
		const report = await runValidators({
			collection: "posts",
			id: null,
			data: { title: "Short", description: "y", body: "z" },
			plugin: fakeCtx,
		});
		expect(report.findings.some((f) => f.severity === "warn" && /Title length/.test(f.message))).toBe(true);
	});

	it("warns on short body", async () => {
		const report = await runValidators({
			collection: "posts",
			id: null,
			data: {
				title: "An Excellent Eight-Word Title For Our Product Launch Today",
				description: "A description of the right length for SEO purposes overall",
				body: "tiny",
			},
			plugin: fakeCtx,
		});
		expect(report.findings.some((f) => /short/i.test(f.message))).toBe(true);
	});

	it("returns ok:true when all SEO checks pass with warns only", async () => {
		const report = await runValidators({
			collection: "posts",
			id: null,
			data: {
				title: "An Excellent Eight-Word Title For Our Product Launch Today",
				description: "A description of the right length for SEO purposes overall",
				slug: "product-launch",
				body: "Body content. ".repeat(100),
			},
			plugin: fakeCtx,
		});
		expect(report.ok).toBe(true);
	});
});
