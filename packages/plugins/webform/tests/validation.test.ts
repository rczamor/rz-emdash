import { describe, expect, it } from "vitest";

import {
	isValidFormId,
	isVisible,
	validateField,
	validateString,
	validateSubmission,
} from "../src/pure.js";
import type { FieldDef, FormDefinition } from "../src/types.js";
import { f, text } from "./_helpers.js";

type FieldBase = Pick<FieldDef, "name" | "type" | "label">;

describe("isVisible", () => {
	const data = { country: "US", tags: ["a", "b"], note: "hello world", n: 0 };

	it("returns true with no condition", () => {
		expect(isVisible(text(), data)).toBe(true);
	});

	it.each<[string, FieldBase & Partial<FieldDef>, boolean]>([
		["eq match", text({ visibleIf: { field: "country", op: "eq", value: "US" } }), true],
		["ne match", text({ visibleIf: { field: "country", op: "ne", value: "US" } }), false],
		["in match", text({ visibleIf: { field: "country", op: "in", value: ["US", "CA"] } }), true],
		["notIn match", text({ visibleIf: { field: "country", op: "notIn", value: ["US"] } }), false],
		["contains", text({ visibleIf: { field: "note", op: "contains", value: "world" } }), true],
		["empty (missing key)", text({ visibleIf: { field: "missing", op: "empty" } }), true],
		["notEmpty", text({ visibleIf: { field: "country", op: "notEmpty" } }), true],
		["empty on populated", text({ visibleIf: { field: "country", op: "empty" } }), false],
	])("%s", (_, field, expected) => {
		expect(isVisible(field as FieldDef, data)).toBe(expected);
	});
});

describe("validateString", () => {
	it("enforces minLength / maxLength / pattern", () => {
		const def = text({ minLength: 3, maxLength: 5, pattern: "^[a-z]+$" });
		expect(validateString("ab", def)).toMatch(/at least 3/);
		expect(validateString("abcdef", def)).toMatch(/at most 5/);
		expect(validateString("AB1", def)).toMatch(/format is invalid/);
		expect(validateString("abc", def)).toBeNull();
	});
});

describe("validateField — primitives", () => {
	it.each<[string, FieldDef, unknown, RegExp | null]>([
		["required text empty", text({ label: "Name", required: true }), "", /required/],
		["required text ok", text({ label: "Name", required: true }), "hi", null],
		["bad email", f({ name: "e", type: "email", label: "Email" }), "nope", /email/],
		["good email", f({ name: "e", type: "email", label: "Email" }), "a@b.co", null],
		["non-http url", f({ name: "u", type: "url", label: "URL" }), "ftp://x.com", /valid URL/],
		["malformed url", f({ name: "u", type: "url", label: "URL" }), "not a url", /valid URL/],
		["good url", f({ name: "u", type: "url", label: "URL" }), "https://x.com", null],
		[
			"non-numeric",
			f({ name: "n", type: "number", label: "N", min: 1, max: 10 }),
			"abc",
			/must be a number/,
		],
		["below min", f({ name: "n", type: "number", label: "N", min: 1, max: 10 }), "0", /≥ 1/],
		["above max", f({ name: "n", type: "number", label: "N", min: 1, max: 10 }), "11", /≤ 10/],
		["in range", f({ name: "n", type: "number", label: "N", min: 1, max: 10 }), "5", null],
		["bad color", f({ name: "c", type: "color", label: "C" }), "red", /hex/],
		["good color", f({ name: "c", type: "color", label: "C" }), "#ff0000", null],
		["empty optional", text(), "", null],
	])("%s", (_, def, value, match) => {
		const err = validateField(value, def);
		if (match === null) expect(err).toBeNull();
		else expect(err).toMatch(match);
	});

	it("select / radio enforce option set", () => {
		const def = f({ name: "s", type: "select", label: "S", options: [{ value: "a", label: "A" }] });
		expect(validateField("b", def)).toMatch(/not a valid choice/);
		expect(validateField("a", def)).toBeNull();
	});
});

describe("validateField — checkbox group", () => {
	const def = f({
		name: "tags",
		type: "checkbox-group",
		label: "Tags",
		required: true,
		options: [
			{ value: "a", label: "A" },
			{ value: "b", label: "B" },
		],
	});

	it.each([
		["empty when required", [], /at least one/],
		["unknown choice", ["a", "x"], /not a valid choice/],
	])("%s", (_, value, match) => {
		expect(validateField(value, def)).toMatch(match);
	});

	it("accepts valid", () => {
		expect(validateField(["a", "b"], def)).toBeNull();
	});
});

describe("validateField — file", () => {
	const ref = { mediaId: "m1", filename: "doc.pdf", mimeType: "application/pdf", sizeBytes: 1000 };
	const file = (extra: Partial<FieldDef> = {}) =>
		f({ name: "f", type: "file", label: "F", ...extra });

	it("required", () => {
		expect(validateField(null, file({ required: true }))).toMatch(/required/);
	});

	it("multiple=false rejects array > 1", () => {
		expect(validateField([ref, { ...ref, mediaId: "m2" }], file())).toMatch(/only one/);
	});

	it("size limit", () => {
		expect(validateField(ref, file({ maxSizeBytes: 500 }))).toMatch(/exceeds/);
	});

	it("accept filter", () => {
		expect(validateField(ref, file({ accept: "image/*" }))).toMatch(/not an allowed/);
		expect(validateField(ref, file({ accept: ".pdf" }))).toBeNull();
	});
});

describe("validateSubmission", () => {
	const form: FormDefinition = {
		id: "t",
		title: "T",
		fields: [
			f({ name: "name", type: "text", label: "Name", required: true }),
			f({ name: "email", type: "email", label: "Email", required: true }),
			f({
				name: "extra",
				type: "text",
				label: "Extra",
				visibleIf: { field: "name", op: "eq", value: "show" },
			}),
		],
	};

	it("returns null on valid", () => {
		expect(validateSubmission({ name: "x", email: "a@b.co" }, form)).toBeNull();
	});

	it("collects errors", () => {
		const errs = validateSubmission({ name: "", email: "bad" }, form);
		expect(errs).toEqual({ name: expect.any(String), email: expect.any(String) });
	});

	it("skips hidden fields", () => {
		expect(validateSubmission({ name: "x", email: "a@b.co", extra: "" }, form)).toBeNull();
	});
});

describe("isValidFormId", () => {
	it.each<[unknown, boolean]>([
		["contact-us", true],
		["a", true],
		["a1-2b", true],
		["Contact", false],
		["-abc", false],
		["", false],
		[123, false],
		["a".repeat(65), false],
	])("isValidFormId(%p) → %s", (id, expected) => {
		expect(isValidFormId(id)).toBe(expected);
	});
});
