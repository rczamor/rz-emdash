import { describe, it, expect } from "vitest";

import {
	csvEscape,
	formatBytes,
	isValidFormId,
	isVisible,
	mimeMatches,
	normaliseFileRefs,
	preprocessForStorage,
	sanitiseHtml,
	validateField,
	validateString,
	validateSubmission,
} from "../src/pure.js";
import type { FieldDef, FormDefinition } from "../src/types.js";

const f = (def: Partial<FieldDef> & Pick<FieldDef, "name" | "type" | "label">): FieldDef =>
	def as FieldDef;

describe("isVisible", () => {
	const data = { country: "US", tags: ["a", "b"], note: "hello world", n: 0 };

	it("returns true with no condition", () => {
		expect(isVisible(f({ name: "x", type: "text", label: "X" }), data)).toBe(true);
	});

	it("eq / ne", () => {
		expect(isVisible(f({ name: "x", type: "text", label: "X", visibleIf: { field: "country", op: "eq", value: "US" } }), data)).toBe(true);
		expect(isVisible(f({ name: "x", type: "text", label: "X", visibleIf: { field: "country", op: "ne", value: "US" } }), data)).toBe(false);
	});

	it("in / notIn", () => {
		expect(isVisible(f({ name: "x", type: "text", label: "X", visibleIf: { field: "country", op: "in", value: ["US", "CA"] } }), data)).toBe(true);
		expect(isVisible(f({ name: "x", type: "text", label: "X", visibleIf: { field: "country", op: "notIn", value: ["US"] } }), data)).toBe(false);
	});

	it("contains", () => {
		expect(isVisible(f({ name: "x", type: "text", label: "X", visibleIf: { field: "note", op: "contains", value: "world" } }), data)).toBe(true);
	});

	it("empty / notEmpty", () => {
		expect(isVisible(f({ name: "x", type: "text", label: "X", visibleIf: { field: "missing", op: "empty" } }), data)).toBe(true);
		expect(isVisible(f({ name: "x", type: "text", label: "X", visibleIf: { field: "country", op: "notEmpty" } }), data)).toBe(true);
		expect(isVisible(f({ name: "x", type: "text", label: "X", visibleIf: { field: "country", op: "empty" } }), data)).toBe(false);
	});
});

describe("validateString", () => {
	it("enforces minLength / maxLength / pattern", () => {
		const def = f({ name: "x", type: "text", label: "X", minLength: 3, maxLength: 5, pattern: "^[a-z]+$" });
		expect(validateString("ab", def)).toMatch(/at least 3/);
		expect(validateString("abcdef", def)).toMatch(/at most 5/);
		expect(validateString("AB1", def)).toMatch(/format is invalid/);
		expect(validateString("abc", def)).toBeNull();
	});
});

describe("validateField — primitives", () => {
	it("required text", () => {
		expect(validateField("", f({ name: "x", type: "text", label: "Name", required: true }))).toMatch(/required/);
		expect(validateField("hi", f({ name: "x", type: "text", label: "Name", required: true }))).toBeNull();
	});

	it("email", () => {
		expect(validateField("nope", f({ name: "e", type: "email", label: "Email" }))).toMatch(/email/);
		expect(validateField("a@b.co", f({ name: "e", type: "email", label: "Email" }))).toBeNull();
	});

	it("url requires http(s)", () => {
		expect(validateField("ftp://x.com", f({ name: "u", type: "url", label: "URL" }))).toMatch(/valid URL/);
		expect(validateField("not a url", f({ name: "u", type: "url", label: "URL" }))).toMatch(/valid URL/);
		expect(validateField("https://x.com", f({ name: "u", type: "url", label: "URL" }))).toBeNull();
	});

	it("number with min/max", () => {
		const def = f({ name: "n", type: "number", label: "N", min: 1, max: 10 });
		expect(validateField("abc", def)).toMatch(/must be a number/);
		expect(validateField("0", def)).toMatch(/≥ 1/);
		expect(validateField("11", def)).toMatch(/≤ 10/);
		expect(validateField("5", def)).toBeNull();
	});

	it("color hex", () => {
		expect(validateField("red", f({ name: "c", type: "color", label: "C" }))).toMatch(/hex/);
		expect(validateField("#ff0000", f({ name: "c", type: "color", label: "C" }))).toBeNull();
	});

	it("select / radio enforce option set", () => {
		const def = f({ name: "s", type: "select", label: "S", options: [{ value: "a", label: "A" }] });
		expect(validateField("b", def)).toMatch(/not a valid choice/);
		expect(validateField("a", def)).toBeNull();
	});

	it("empty optional returns null", () => {
		expect(validateField("", f({ name: "x", type: "text", label: "X" }))).toBeNull();
	});
});

describe("validateField — checkbox group", () => {
	const def = f({
		name: "tags", type: "checkbox-group", label: "Tags", required: true,
		options: [{ value: "a", label: "A" }, { value: "b", label: "B" }],
	});

	it("requires at least one when required", () => {
		expect(validateField([], def)).toMatch(/at least one/);
	});

	it("rejects unknown choices", () => {
		expect(validateField(["a", "x"], def)).toMatch(/not a valid choice/);
	});

	it("accepts valid", () => {
		expect(validateField(["a", "b"], def)).toBeNull();
	});
});

describe("validateField — file", () => {
	const ref = { mediaId: "m1", filename: "doc.pdf", mimeType: "application/pdf", sizeBytes: 1000 };

	it("required", () => {
		expect(validateField(null, f({ name: "f", type: "file", label: "F", required: true }))).toMatch(/required/);
	});

	it("multiple=false rejects array > 1", () => {
		expect(validateField([ref, { ...ref, mediaId: "m2" }], f({ name: "f", type: "file", label: "F" }))).toMatch(/only one/);
	});

	it("size limit", () => {
		expect(validateField(ref, f({ name: "f", type: "file", label: "F", maxSizeBytes: 500 }))).toMatch(/exceeds/);
	});

	it("accept filter", () => {
		expect(validateField(ref, f({ name: "f", type: "file", label: "F", accept: "image/*" }))).toMatch(/not an allowed/);
		expect(validateField(ref, f({ name: "f", type: "file", label: "F", accept: ".pdf" }))).toBeNull();
	});
});

describe("validateSubmission", () => {
	const form: FormDefinition = {
		id: "t", title: "T",
		fields: [
			f({ name: "name", type: "text", label: "Name", required: true }),
			f({ name: "email", type: "email", label: "Email", required: true }),
			f({ name: "extra", type: "text", label: "Extra", visibleIf: { field: "name", op: "eq", value: "show" } }),
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

describe("sanitiseHtml", () => {
	it("strips script/style", () => {
		expect(sanitiseHtml("<p>ok</p><script>bad()</script>")).not.toMatch(/script/i);
	});

	it("strips disallowed tags", () => {
		expect(sanitiseHtml("<iframe src=x></iframe><p>ok</p>")).not.toMatch(/iframe/i);
	});

	it("strips on* handlers", () => {
		expect(sanitiseHtml('<a href="x" onclick="bad()">x</a>')).not.toMatch(/onclick/i);
	});

	it("strips javascript: hrefs", () => {
		expect(sanitiseHtml('<a href="javascript:alert(1)">x</a>')).not.toMatch(/javascript:/i);
	});

	it("preserves allowed tags", () => {
		expect(sanitiseHtml("<p><strong>hi</strong></p>")).toMatch(/<strong>/);
	});
});

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
		expect(normaliseFileRefs([{ mediaId: "1" }, { filename: "f", mediaId: "2", mimeType: "x", sizeBytes: 1 }])).toHaveLength(1);
	});
});

describe("formatBytes", () => {
	it("formats", () => {
		expect(formatBytes(500)).toBe("500 B");
		expect(formatBytes(2048)).toBe("2 KB");
		expect(formatBytes(2 * 1024 * 1024)).toBe("2.0 MB");
	});
});

describe("mimeMatches", () => {
	it("exact mime", () => {
		expect(mimeMatches("image/png", "x.png", "image/png")).toBe(true);
	});

	it("wildcard", () => {
		expect(mimeMatches("image/jpeg", "x.jpg", "image/*")).toBe(true);
		expect(mimeMatches("video/mp4", "x.mp4", "image/*")).toBe(false);
	});

	it("extension", () => {
		expect(mimeMatches("application/x", "doc.pdf", ".pdf")).toBe(true);
		expect(mimeMatches("application/x", "doc.txt", ".pdf")).toBe(false);
	});

	it("comma list", () => {
		expect(mimeMatches("image/png", "x.png", ".pdf, image/*")).toBe(true);
	});
});

describe("csvEscape", () => {
	it("plain", () => {
		expect(csvEscape("hello")).toBe("hello");
		expect(csvEscape(null)).toBe("");
	});

	it("escapes commas, quotes, newlines", () => {
		expect(csvEscape('a,b')).toBe('"a,b"');
		expect(csvEscape('a"b')).toBe('"a""b"');
		expect(csvEscape("a\nb")).toBe('"a\nb"');
	});

	it("stringifies objects", () => {
		expect(csvEscape({ a: 1 })).toBe('"{""a"":1}"');
	});
});

describe("isValidFormId", () => {
	it("accepts lowercase + digits + hyphens", () => {
		expect(isValidFormId("contact-us")).toBe(true);
		expect(isValidFormId("a")).toBe(true);
		expect(isValidFormId("a1-2b")).toBe(true);
	});

	it("rejects invalid", () => {
		expect(isValidFormId("Contact")).toBe(false);
		expect(isValidFormId("-abc")).toBe(false);
		expect(isValidFormId("")).toBe(false);
		expect(isValidFormId(123)).toBe(false);
		expect(isValidFormId("a".repeat(65))).toBe(false);
	});
});

describe("preprocessForStorage", () => {
	const form: FormDefinition = {
		id: "t", title: "T",
		fields: [
			f({ name: "bio", type: "html", label: "Bio" }),
			f({ name: "tags", type: "checkbox-group", label: "Tags" }),
			f({ name: "pw", type: "password", label: "PW" }),
			f({ name: "name", type: "text", label: "Name" }),
		],
	};

	it("sanitises html, wraps cb-group, redacts password", () => {
		const out = preprocessForStorage(
			{ bio: "<script>x</script><p>ok</p>", tags: "single", pw: "secret", name: "Alice" },
			form,
		);
		expect(out.bio).not.toMatch(/script/);
		expect(out.tags).toEqual(["single"]);
		expect(out.pw).toBe("***");
		expect(out.name).toBe("Alice");
	});

	it("skips nullish fields", () => {
		const out = preprocessForStorage({ name: "x" }, form);
		expect(out).toEqual({ name: "x" });
	});
});
