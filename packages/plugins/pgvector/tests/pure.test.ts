import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { indexType, newId, tableName, toVectorLiteral } from "../src/db.js";

describe("tableName", () => {
	it.each([
		[1, "pgvector_embeddings_1"],
		[1536, "pgvector_embeddings_1536"],
		[3072, "pgvector_embeddings_3072"],
		[16_000, "pgvector_embeddings_16000"],
	])("dim=%i → %s", (dim, expected) => {
		expect(tableName(dim)).toBe(expected);
	});

	it.each([0, -1, 16_001, 1.5, NaN, Infinity])("rejects: dim=%p", (dim) => {
		expect(() => tableName(dim)).toThrow(/Invalid embedding dimension/);
	});
});

describe("indexType", () => {
	const orig = process.env.PGVECTOR_INDEX_TYPE;

	beforeEach(() => {
		delete process.env.PGVECTOR_INDEX_TYPE;
	});

	afterEach(() => {
		if (orig === undefined) delete process.env.PGVECTOR_INDEX_TYPE;
		else process.env.PGVECTOR_INDEX_TYPE = orig;
	});

	it("defaults to hnsw when env var is unset", () => {
		expect(indexType()).toBe("hnsw");
	});

	it("returns hnsw when explicitly set", () => {
		process.env.PGVECTOR_INDEX_TYPE = "hnsw";
		expect(indexType()).toBe("hnsw");
	});

	it("returns ivfflat when set", () => {
		process.env.PGVECTOR_INDEX_TYPE = "ivfflat";
		expect(indexType()).toBe("ivfflat");
	});

	it("is case-insensitive", () => {
		process.env.PGVECTOR_INDEX_TYPE = "IVFFlat";
		expect(indexType()).toBe("ivfflat");
	});

	it("falls back to hnsw on unknown value", () => {
		process.env.PGVECTOR_INDEX_TYPE = "annoy";
		expect(indexType()).toBe("hnsw");
	});
});

describe("toVectorLiteral", () => {
	it("formats an empty array", () => {
		expect(toVectorLiteral([])).toBe("[]");
	});

	it("formats a single value", () => {
		expect(toVectorLiteral([0.5])).toBe("[0.5]");
	});

	it("formats mixed integers and floats", () => {
		expect(toVectorLiteral([0, 1, -1.5, 2.71828])).toBe("[0,1,-1.5,2.71828]");
	});

	it("preserves precision (no rounding)", () => {
		expect(toVectorLiteral([0.123456789])).toBe("[0.123456789]");
	});

	it("renders scientific notation as-is from Number.toString()", () => {
		expect(toVectorLiteral([1e-7])).toBe("[1e-7]");
	});
});

describe("newId", () => {
	it("matches the emb_<timestamp>_<8-char-suffix> shape", () => {
		expect(newId()).toMatch(/^emb_\d+_[0-9a-z]{1,8}$/);
	});

	it("returns distinct IDs across calls", () => {
		const ids = new Set<string>();
		for (let i = 0; i < 50; i++) {
			ids.add(newId());
		}
		expect(ids.size).toBe(50);
	});
});
