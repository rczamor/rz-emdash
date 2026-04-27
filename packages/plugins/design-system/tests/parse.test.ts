import { describe, it, expect } from "vitest";

import {
	assembleDesignSystemBlock,
	contrastRatio,
	exportTailwindConfig,
	parseDesignSystem,
	resolveTokens,
	validateDesignSystem,
} from "../src/parse.js";

describe("parseDesignSystem", () => {
	it("parses frontmatter + body", () => {
		const src = `---
name: Test
version: "1.0"
colors:
  primary: "#ff6600"
---

## Overview

Plain language.
`;
		const parsed = parseDesignSystem(src);
		expect(parsed.frontmatter.name).toBe("Test");
		expect(parsed.frontmatter.version).toBe("1.0");
		expect(parsed.frontmatter.colors).toEqual({ primary: "#ff6600" });
		expect(parsed.sections).toHaveLength(1);
		expect(parsed.sections[0]?.heading).toBe("Overview");
		expect(parsed.sections[0]?.body).toBe("Plain language.");
	});

	it("parses with no frontmatter", () => {
		const parsed = parseDesignSystem("## Just a heading\n\nBody.");
		expect(parsed.frontmatter).toEqual({});
		expect(parsed.sections).toHaveLength(1);
	});

	it("preserves rawSource and parsedAt", () => {
		const src = "---\nname: X\n---\n";
		const parsed = parseDesignSystem(src);
		expect(parsed.rawSource).toBe(src);
		expect(parsed.parsedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});

	it("recovers gracefully from invalid yaml", () => {
		const src = "---\n: : :\nbroken\n---\n\n## Valid section\n";
		const parsed = parseDesignSystem(src);
		// Frontmatter swallowed — sections still parsed.
		expect(parsed.sections).toHaveLength(1);
	});

	it("captures level-3+ headings as their own sections", () => {
		const src = "## H2\n\n### H3\n\n#### H4\n";
		const parsed = parseDesignSystem(src);
		expect(parsed.sections.map((s) => s.level)).toEqual([2, 3, 4]);
	});
});

describe("validateDesignSystem", () => {
	it("flags duplicate level-2 headings as error", () => {
		const parsed = parseDesignSystem("## Colors\n\n## Colors\n");
		const report = validateDesignSystem(parsed);
		expect(report.ok).toBe(false);
		expect(report.findings.some((f) => f.code === "duplicate-section")).toBe(true);
	});

	it("does NOT flag duplicate level-3 headings (only level 2 is restricted)", () => {
		const parsed = parseDesignSystem("## A\n\n### B\n\n### B\n");
		const report = validateDesignSystem(parsed);
		expect(report.findings.some((f) => f.code === "duplicate-section")).toBe(false);
	});

	it("flags broken token refs in body", () => {
		const src = `---
colors:
  primary: "#ff6600"
---

## Use

Apply {colors.nonexistent} sparingly.
`;
		const parsed = parseDesignSystem(src);
		const report = validateDesignSystem(parsed);
		expect(report.findings.some((f) => f.code === "broken-token-ref")).toBe(true);
	});

	it("does not flag valid token refs", () => {
		const src = `---
colors:
  primary: "#ff6600"
---

## Use

Apply {colors.primary} for CTAs.
`;
		const parsed = parseDesignSystem(src);
		const report = validateDesignSystem(parsed);
		expect(report.findings.some((f) => f.code === "broken-token-ref")).toBe(false);
	});

	it("warns on missing frontmatter name", () => {
		const parsed = parseDesignSystem("## Section\n\nbody");
		const report = validateDesignSystem(parsed);
		expect(report.findings.some((f) => f.code === "missing-name")).toBe(true);
	});

	it("flags WCAG contrast errors when text on bg < 3", () => {
		const src = `---
name: X
colors:
  text: "#888888"
  background: "#777777"
---
`;
		const parsed = parseDesignSystem(src);
		const report = validateDesignSystem(parsed);
		// 4.5 spec wants ≥4.5 — should at least warn.
		expect(report.findings.some((f) => f.code === "wcag-contrast")).toBe(true);
	});

	it("does NOT flag adequate contrast", () => {
		const src = `---
name: X
colors:
  text: "#000000"
  background: "#ffffff"
---
`;
		const parsed = parseDesignSystem(src);
		const report = validateDesignSystem(parsed);
		expect(report.findings.some((f) => f.code === "wcag-contrast")).toBe(false);
	});

	it("emits info level for unknown sections", () => {
		const parsed = parseDesignSystem("## Quirky Section\n\n## Colors\n");
		const report = validateDesignSystem(parsed);
		const info = report.findings.find(
			(f) => f.code === "unknown-section" && f.location === "Quirky Section",
		);
		expect(info).toBeDefined();
		expect(info?.level).toBe("info");
	});

	it("recognises spec-known sections without info findings", () => {
		const known = [
			"Overview",
			"Colors",
			"Typography",
			"Layout",
			"Elevation",
			"Shapes",
			"Components",
		];
		const src = known.map((h) => `## ${h}\n\nbody\n`).join("\n");
		const parsed = parseDesignSystem(`---\nname: X\n---\n\n${src}`);
		const report = validateDesignSystem(parsed);
		expect(report.findings.filter((f) => f.code === "unknown-section")).toHaveLength(0);
	});

	it("ok=true when only warnings/info present", () => {
		const parsed = parseDesignSystem("## Colors\n");
		const report = validateDesignSystem(parsed);
		expect(report.ok).toBe(true);
	});

	it("ok=false on any error", () => {
		const parsed = parseDesignSystem("## A\n\n## A\n");
		const report = validateDesignSystem(parsed);
		expect(report.ok).toBe(false);
	});
});

describe("resolveTokens", () => {
	it("substitutes {colors.x} in string values", () => {
		const fm = {
			colors: { primary: "#ff6600" },
			components: { button: { background: "{colors.primary}" } },
		};
		const { resolved, unresolved } = resolveTokens(fm);
		expect((resolved.components as Record<string, Record<string, unknown>>).button.background).toBe(
			"#ff6600",
		);
		expect(unresolved).toEqual([]);
	});

	it("collects unresolved refs", () => {
		const fm = {
			colors: { primary: "#ff6600" },
			components: { button: { background: "{colors.missing}" } },
		};
		const { unresolved } = resolveTokens(fm);
		expect(unresolved).toContain("colors.missing");
	});

	it("handles ColorToken { value } shape", () => {
		const fm = {
			colors: { primary: { value: "#ff6600", description: "brand orange" } },
			components: { button: { background: "{colors.primary}" } },
		};
		const { resolved } = resolveTokens(fm);
		expect((resolved.components as Record<string, Record<string, unknown>>).button.background).toBe(
			"#ff6600",
		);
	});
});

describe("contrastRatio", () => {
	it("white on black is 21", () => {
		const ratio = contrastRatio("#ffffff", "#000000");
		expect(ratio).toBeCloseTo(21, 0);
	});

	it("white on white is 1", () => {
		expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 2);
	});

	it("returns null for invalid hex", () => {
		expect(contrastRatio("not-a-color", "#000")).toBeNull();
	});

	it("supports 3-digit hex", () => {
		expect(contrastRatio("#000", "#fff")).toBeCloseTo(21, 0);
	});

	it("is order-independent", () => {
		const a = contrastRatio("#ff0000", "#00ff00");
		const b = contrastRatio("#00ff00", "#ff0000");
		expect(a).toBeCloseTo(b!, 4);
	});
});

describe("exportTailwindConfig", () => {
	it("emits theme.extend.colors from string values", () => {
		const fm = { colors: { primary: "#ff6600", text: "#fff" } };
		const out = exportTailwindConfig(fm);
		const colors = (out.theme as Record<string, unknown>).extend as Record<string, unknown>;
		expect(colors.colors).toEqual({ primary: "#ff6600", text: "#fff" });
	});

	it("emits typography fontFamily as a list", () => {
		const fm = {
			typography: {
				body: { fontFamily: "Inter, system-ui", fontSize: "16px" },
			},
		};
		const out = exportTailwindConfig(fm);
		const extend = (out.theme as Record<string, unknown>).extend as Record<string, unknown>;
		expect((extend.fontFamily as Record<string, string[]>).body).toEqual(["Inter", "system-ui"]);
		expect((extend.fontSize as Record<string, string>).body).toBe("16px");
	});

	it("emits spacing + borderRadius", () => {
		const fm = {
			spacing: { "1": "4px", "2": "8px" },
			rounded: { sm: "4px", md: "8px" },
		};
		const out = exportTailwindConfig(fm);
		const extend = (out.theme as Record<string, unknown>).extend as Record<string, unknown>;
		expect(extend.spacing).toEqual({ "1": "4px", "2": "8px" });
		expect(extend.borderRadius).toEqual({ sm: "4px", md: "8px" });
	});

	it("handles ColorToken object shape", () => {
		const fm = { colors: { primary: { value: "#ff6600", description: "brand" } } };
		const out = exportTailwindConfig(fm);
		const extend = (out.theme as Record<string, unknown>).extend as Record<string, unknown>;
		expect((extend.colors as Record<string, string>).primary).toBe("#ff6600");
	});

	it("returns empty extend when nothing relevant in frontmatter", () => {
		const out = exportTailwindConfig({ name: "X" });
		const extend = (out.theme as Record<string, unknown>).extend as Record<string, unknown>;
		expect(extend.colors).toEqual({});
		expect(extend.fontFamily).toEqual({});
	});
});

describe("assembleDesignSystemBlock", () => {
	const fullSrc = `---
name: EmDash
description: Plain language.
colors:
  primary: "#ff6600"
  text: "#fff"
typography:
  body: { fontFamily: Inter, fontSize: 16px }
---

## Do's and Don'ts

- ✅ Lead with the work
- ❌ Hero gradients
`;

	it("produces a markdown block with name + colors + typography", () => {
		const block = assembleDesignSystemBlock(parseDesignSystem(fullSrc));
		expect(block).toContain("# Design system: EmDash");
		expect(block).toContain("Plain language.");
		expect(block).toContain("**primary**: #ff6600");
		expect(block).toContain("Inter");
		expect(block).toContain("Lead with the work");
	});

	// Snapshot — locks ordering so a regression in section emit order
	// (e.g. typography rendered before colors) is visible at a glance.
	it("matches full markdown snapshot", () => {
		expect(assembleDesignSystemBlock(parseDesignSystem(fullSrc))).toMatchSnapshot();
	});

	it("omits sections that aren't present", () => {
		const parsed = parseDesignSystem(`---
name: X
---
`);
		const block = assembleDesignSystemBlock(parsed);
		expect(block).not.toContain("Colors");
		expect(block).not.toContain("Typography");
	});

	it("includes Do's and Don'ts when present", () => {
		const parsed = parseDesignSystem(`---
name: X
---

## Do's and Don'ts

DO be specific.
`);
		const block = assembleDesignSystemBlock(parsed);
		expect(block).toContain("Do's and Don'ts");
		expect(block).toContain("DO be specific");
	});
});
