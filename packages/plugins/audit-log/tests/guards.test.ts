import { describe, expect, it } from "vitest";

import { isAuditEntry, isRecord } from "../src/guards.js";

describe("isRecord", () => {
	it.each<[string, unknown, boolean]>([
		["empty object", {}, true],
		["populated object", { a: 1 }, true],
		["null", null, false],
		["undefined", undefined, false],
		["array", [], false],
		["string", "x", false],
		["number", 1, false],
		["boolean", true, false],
	])("%s → %s", (_, value, expected) => {
		expect(isRecord(value)).toBe(expected);
	});
});

describe("isAuditEntry", () => {
	const valid = {
		timestamp: "2026-01-01T00:00:00Z",
		action: "create",
		resourceId: "post:42",
		resourceType: "content",
	};

	it("accepts a valid entry", () => {
		expect(isAuditEntry(valid)).toBe(true);
	});

	it("accepts an entry with optional fields", () => {
		expect(
			isAuditEntry({
				...valid,
				userId: "u1",
				collection: "posts",
				changes: { before: { title: "old" }, after: { title: "new" } },
				metadata: { source: "api" },
			}),
		).toBe(true);
	});

	it.each<[string, Record<string, unknown>]>([
		["missing timestamp", { action: "x", resourceId: "y", resourceType: "content" }],
		["missing action", { timestamp: "t", resourceId: "y", resourceType: "content" }],
		["missing resourceId", { timestamp: "t", action: "x", resourceType: "content" }],
		["missing resourceType", { timestamp: "t", action: "x", resourceId: "y" }],
		["timestamp is non-string", { ...valid, timestamp: 12345 }],
		["resourceType is non-string", { ...valid, resourceType: null }],
	])("rejects: %s", (_, entry) => {
		expect(isAuditEntry(entry)).toBe(false);
	});

	it.each<[string, unknown]>([
		["null", null],
		["array", []],
		["string", "audit"],
	])("rejects non-object: %s", (_, value) => {
		expect(isAuditEntry(value)).toBe(false);
	});
});
