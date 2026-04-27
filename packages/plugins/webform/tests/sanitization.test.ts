import { describe, expect, it } from "vitest";

import { preprocessForStorage, sanitiseHtml } from "../src/pure.js";
import type { FormDefinition } from "../src/types.js";
import { f } from "./_helpers.js";

describe("sanitiseHtml", () => {
	it.each([
		["strips script", "<p>ok</p><script>bad()</script>", /script/i, false],
		["strips iframe", "<iframe src=x></iframe><p>ok</p>", /iframe/i, false],
		["strips on* handlers", '<a href="x" onclick="bad()">x</a>', /onclick/i, false],
		["strips javascript: hrefs", '<a href="javascript:alert(1)">x</a>', /javascript:/i, false],
		["preserves allowed tags", "<p><strong>hi</strong></p>", /<strong>/, true],
	])("%s", (_, input, pattern, shouldMatch) => {
		const out = sanitiseHtml(input);
		if (shouldMatch) expect(out).toMatch(pattern);
		else expect(out).not.toMatch(pattern);
	});
});

describe("preprocessForStorage", () => {
	const form: FormDefinition = {
		id: "t",
		title: "T",
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
		expect(preprocessForStorage({ name: "x" }, form)).toEqual({ name: "x" });
	});
});
