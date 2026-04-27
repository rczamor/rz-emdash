import { describe, expect, it } from "vitest";

import { validateSubmission } from "../src/validation.js";
import { field } from "./_helpers.js";

describe("validateSubmission — required + type checks", () => {
	it("accepts a valid submission", () => {
		const r = validateSubmission([field("name", "text", { required: true })], { name: "Ada" });
		expect(r.valid).toBe(true);
		expect(r.errors).toEqual([]);
		expect(r.data).toEqual({ name: "Ada" });
	});

	it("flags missing required field", () => {
		const r = validateSubmission([field("name", "text", { required: true })], {});
		expect(r.valid).toBe(false);
		expect(r.errors).toEqual([{ field: "name", message: "name is required" }]);
	});

	it("treats whitespace-only as empty for required", () => {
		const r = validateSubmission([field("name", "text", { required: true })], { name: "   " });
		expect(r.valid).toBe(false);
	});

	it("skips empty optional fields silently", () => {
		const r = validateSubmission([field("note", "text")], { note: "" });
		expect(r.valid).toBe(true);
		expect(r.data).toEqual({});
	});

	it.each<[string, "email" | "url" | "tel", string, boolean]>([
		["email valid", "email", "a@b.co", true],
		["email invalid", "email", "nope", false],
		["url valid", "url", "https://x.com", true],
		["url no scheme", "url", "x.com", false],
		["tel valid", "tel", "+1 (555) 123-4567", true],
		["tel invalid", "tel", "abc", false],
	])("%s", (_, type, value, expectValid) => {
		const r = validateSubmission([field("v", type)], { v: value });
		expect(r.valid).toBe(expectValid);
	});

	it("number type coerces and rejects non-numeric", () => {
		const ok = validateSubmission([field("n", "number")], { n: "42" });
		expect(ok.valid).toBe(true);
		expect(ok.data).toEqual({ n: 42 });

		const bad = validateSubmission([field("n", "number")], { n: "abc" });
		expect(bad.valid).toBe(false);
	});

	it("date type rejects unparseable strings", () => {
		expect(validateSubmission([field("d", "date")], { d: "2026-04-15" }).valid).toBe(true);
		expect(validateSubmission([field("d", "date")], { d: "not a date" }).valid).toBe(false);
	});

	it("select rejects values outside the option set", () => {
		const def = field("color", "select", {
			options: [
				{ value: "red", label: "Red" },
				{ value: "blue", label: "Blue" },
			],
		});
		expect(validateSubmission([def], { color: "red" }).valid).toBe(true);
		expect(validateSubmission([def], { color: "green" }).valid).toBe(false);
	});

	it("checkbox-group accepts an array of valid options", () => {
		const def = field("tags", "checkbox-group", {
			options: [
				{ value: "a", label: "A" },
				{ value: "b", label: "B" },
			],
		});
		expect(validateSubmission([def], { tags: ["a", "b"] }).valid).toBe(true);
		expect(validateSubmission([def], { tags: ["a", "c"] }).valid).toBe(false);
	});
});

describe("validateSubmission — rules", () => {
	it("enforces minLength / maxLength", () => {
		const def = field("name", "text", { validation: { minLength: 3, maxLength: 5 } });
		expect(validateSubmission([def], { name: "ab" }).errors[0]?.message).toMatch(/at least 3/);
		expect(validateSubmission([def], { name: "abcdef" }).errors[0]?.message).toMatch(/at most 5/);
		expect(validateSubmission([def], { name: "abc" }).valid).toBe(true);
	});

	it("enforces number min/max", () => {
		const def = field("n", "number", { validation: { min: 1, max: 10 } });
		expect(validateSubmission([def], { n: "0" }).errors[0]?.message).toMatch(/at least 1/);
		expect(validateSubmission([def], { n: "11" }).errors[0]?.message).toMatch(/at most 10/);
		expect(validateSubmission([def], { n: "5" }).valid).toBe(true);
	});

	it("uses custom patternMessage", () => {
		const def = field("code", "text", {
			validation: { pattern: "^[A-Z]{3}$", patternMessage: "Three uppercase letters required" },
		});
		const r = validateSubmission([def], { code: "abc" });
		expect(r.errors[0]?.message).toBe("Three uppercase letters required");
	});

	it("ignores invalid regex configurations silently", () => {
		const def = field("code", "text", { validation: { pattern: "[" } });
		const r = validateSubmission([def], { code: "anything" });
		// Pattern check is skipped on bad regex, so the value passes.
		expect(r.valid).toBe(true);
	});
});

describe("validateSubmission — coercion", () => {
	it("checkbox 'on' → true; absent → not validated (skipped)", () => {
		const def = field("agree", "checkbox", { required: true });
		expect(validateSubmission([def], { agree: "on" }).data.agree).toBe(true);
	});

	it("checkbox-group wraps a scalar into an array", () => {
		const def = field("tags", "checkbox-group", {
			options: [{ value: "x", label: "X" }],
		});
		const r = validateSubmission([def], { tags: "x" });
		expect(r.data.tags).toEqual(["x"]);
	});

	it("text values are trimmed", () => {
		const r = validateSubmission([field("name", "text")], { name: "  Ada  " });
		expect(r.data.name).toBe("Ada");
	});
});

describe("validateSubmission — conditional visibility", () => {
	const fields = [
		field("country", "select", {
			required: true,
			options: [
				{ value: "US", label: "US" },
				{ value: "DE", label: "DE" },
			],
		}),
		field("zip", "text", {
			required: true,
			condition: { field: "country", op: "eq", value: "US" },
		}),
	];

	it("hidden field's required check is skipped when condition is false", () => {
		const r = validateSubmission(fields, { country: "DE" });
		expect(r.valid).toBe(true);
		expect(r.data).toEqual({ country: "DE" });
	});

	it("required field's check applies when condition is true", () => {
		const r = validateSubmission(fields, { country: "US" });
		expect(r.valid).toBe(false);
		expect(r.errors.find((e) => e.field === "zip")).toBeDefined();
	});

	it.each([
		["filled", "tag", { tag: "x" }, true],
		["filled (empty)", "tag", { tag: "" }, false],
		["empty (missing)", "tag", {}, false],
		["empty (empty string)", "tag", { tag: "" }, false],
	])("op '%s' resolves correctly", (op, controlField, data, controllerFilled) => {
		const def = field("dep", "text", {
			required: true,
			condition: { field: controlField, op: op as "filled" | "empty" },
		});
		const r = validateSubmission([def], data);
		const expectedShown = op === "filled" ? controllerFilled : !controllerFilled;
		expect(r.valid).toBe(!expectedShown);
	});

	it("op 'neq' inverts equality", () => {
		const def = field("dep", "text", {
			required: true,
			condition: { field: "ctrl", op: "neq", value: "skip" },
		});
		expect(validateSubmission([def], { ctrl: "skip" }).valid).toBe(true); // dep hidden
		expect(validateSubmission([def], { ctrl: "show" }).valid).toBe(false); // dep required
	});
});
