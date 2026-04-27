import { describe, expect, it } from "vitest";

import {
	escapeCsv,
	formatBytes,
	formatCsv,
	formatDigestText,
	formatSubmissionText,
	formatWebhookPayload,
} from "../src/format.js";
import { field, form, submission } from "./_helpers.js";

describe("formatSubmissionText", () => {
	it("renders a simple submission", () => {
		const out = formatSubmissionText(form([field("name", "text"), field("email", "email")]), {
			name: "Ada",
			email: "ada@example.com",
		});
		expect(out).toContain('New submission for "Test"');
		expect(out).toContain("name: Ada");
		expect(out).toContain("email: ada@example.com");
		expect(out).toMatch(/Submitted at: \d{4}-\d{2}-\d{2}T/);
	});

	it("skips hidden fields", () => {
		const out = formatSubmissionText(form([field("secret", "hidden"), field("n", "text")]), {
			secret: "tok",
			n: "v",
		});
		expect(out).not.toContain("secret");
		expect(out).toContain("n: v");
	});

	it("joins arrays with commas", () => {
		const out = formatSubmissionText(form([field("tags", "checkbox-group")]), {
			tags: ["a", "b", "c"],
		});
		expect(out).toContain("tags: a, b, c");
	});

	it("appends file list with sizes", () => {
		const out = formatSubmissionText(form([field("doc", "file")]), {}, [
			{
				fieldName: "doc",
				filename: "report.pdf",
				contentType: "application/pdf",
				size: 2048,
				mediaId: "m1",
			},
		]);
		expect(out).toContain("Attached files:");
		expect(out).toContain("- report.pdf (2.0 KB)");
	});
});

describe("formatDigestText", () => {
	it("singular/plural noun selection", () => {
		const f = form([field("name", "text")]);
		expect(formatDigestText(f, "test", [submission({ name: "A" })], "https://x")).toContain(
			"1 new submission since",
		);
		expect(
			formatDigestText(
				f,
				"test",
				[submission({ name: "A" }), submission({ name: "B" })],
				"https://x",
			),
		).toContain("2 new submissions since");
	});

	it("truncates the preview list at 10 and reports the overflow", () => {
		const f = form([field("name", "text")]);
		const subs = Array.from({ length: 13 }, (_, i) => submission({ name: `n${i}` }));
		const out = formatDigestText(f, "test", subs, "https://x");
		const previewLines = out.split("\n").filter((l) => l.startsWith("  - "));
		expect(previewLines).toHaveLength(10);
		expect(out).toContain("... and 3 more");
	});

	it("URL-encodes the formId in the deep link", () => {
		const out = formatDigestText(form([]), "form/with slashes", [], "https://x");
		expect(out).toContain("formId=form%2Fwith%20slashes");
	});

	it("renders (empty) when no preview text is available", () => {
		const f = form([field("doc", "file")]);
		const out = formatDigestText(f, "test", [submission({})], "https://x");
		expect(out).toContain("(empty)");
	});
});

describe("formatWebhookPayload", () => {
	it("emits the event envelope", () => {
		const out = formatWebhookPayload(form([], { slug: "contact", name: "Contact" }), "sub-1", {
			email: "x@y.com",
		});
		expect(out).toMatchObject({
			event: "form.submission",
			formId: "contact",
			formName: "Contact",
			submissionId: "sub-1",
			data: { email: "x@y.com" },
		});
		expect(typeof out.submittedAt).toBe("string");
	});

	it("strips internal file fields, keeping the public ones", () => {
		const out = formatWebhookPayload(form([]), "sub-1", {}, [
			{
				fieldName: "doc",
				filename: "f.pdf",
				contentType: "application/pdf",
				size: 1,
				mediaId: "m1",
			},
		]);
		expect(out.files).toEqual([
			{
				fieldName: "doc",
				filename: "f.pdf",
				contentType: "application/pdf",
				size: 1,
				mediaId: "m1",
			},
		]);
	});

	it("omits files when none are passed", () => {
		const out = formatWebhookPayload(form([]), "sub-1", {});
		expect(out.files).toBeUndefined();
	});
});

describe("formatCsv", () => {
	const f = form([field("name", "text"), field("notes", "textarea"), field("secret", "hidden")]);

	it("emits headers + a row per submission", () => {
		const csv = formatCsv(f, [
			{ id: "s1", data: submission({ name: "Ada", notes: "ok", secret: "tok" }) },
		]);
		const [header, row] = csv.split("\n");
		expect(header).toBe("ID,Submitted At,Status,name,notes");
		expect(row).toBe("s1,2026-01-01T12:00:00Z,new,Ada,ok");
	});

	it("excludes hidden fields from the header", () => {
		const csv = formatCsv(f, []);
		expect(csv).not.toContain("secret");
	});

	it("joins array values with semicolons", () => {
		const f2 = form([field("tags", "checkbox-group")]);
		const csv = formatCsv(f2, [{ id: "s1", data: submission({ tags: ["a", "b"] }) }]);
		expect(csv).toContain("a; b");
	});
});

describe("escapeCsv — injection prevention", () => {
	it("leaves plain values alone", () => {
		expect(escapeCsv("hello")).toBe("hello");
	});

	it("quotes values containing delimiters", () => {
		expect(escapeCsv("a,b")).toBe('"a,b"');
		expect(escapeCsv("a\nb")).toBe('"a\nb"');
		expect(escapeCsv('a"b')).toBe('"a""b"');
	});

	it.each(["=cmd|' /C calc'!A0", "+SUM(A1:A2)", "-2+3", "@cmd", "\tinjected", "\rfoo"])(
		"prefixes a single-quote to neutralize formula trigger: %j",
		(input) => {
			const escaped = escapeCsv(input);
			expect(escaped.startsWith("'")).toBe(true);
		},
	);

	it("formula-prefixed values are still CSV-escaped if they contain delimiters", () => {
		expect(escapeCsv("=A,B")).toBe(`"'=A,B"`);
	});
});

describe("formatBytes", () => {
	it.each([
		[0, "0 B"],
		[1023, "1023 B"],
		[1024, "1.0 KB"],
		[2048, "2.0 KB"],
		[1024 * 1024, "1.0 MB"],
		[2.5 * 1024 * 1024, "2.5 MB"],
	])("formatBytes(%i) → %s", (bytes, expected) => {
		expect(formatBytes(bytes)).toBe(expected);
	});
});
