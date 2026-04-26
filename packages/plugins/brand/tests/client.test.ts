import { describe, it, expect } from "vitest";

import { assembleBrandSystemBlock, detectBannedPhrases } from "../src/client.js";
import type { Brand } from "../src/types.js";

function makeBrand(overrides: Partial<Brand> = {}): Brand {
	return {
		id: "default",
		name: "Test Brand",
		positioning: "We make stuff.",
		voice_attributes: [],
		tone_rules: [],
		vocabulary: [],
		banned_phrases: [],
		examples: [],
		active: true,
		created_at: "2026-04-26T00:00:00Z",
		updated_at: "2026-04-26T00:00:00Z",
		...overrides,
	};
}

describe("detectBannedPhrases", () => {
	it("returns matching phrases (case-insensitive)", () => {
		const brand = makeBrand({ banned_phrases: ["best in class", "synergy"] });
		const found = detectBannedPhrases("Our BEST IN CLASS solution", brand);
		expect(found).toEqual(["best in class"]);
	});

	it("matches multiple banned phrases", () => {
		const brand = makeBrand({ banned_phrases: ["synergy", "moving forward"] });
		const found = detectBannedPhrases("synergy moving forward", brand);
		expect(found.sort()).toEqual(["moving forward", "synergy"]);
	});

	it("returns [] for clean text", () => {
		const brand = makeBrand({ banned_phrases: ["synergy"] });
		expect(detectBannedPhrases("perfectly fine prose", brand)).toEqual([]);
	});

	it("returns [] when no banned phrases configured", () => {
		const brand = makeBrand({ banned_phrases: [] });
		expect(detectBannedPhrases("anything goes", brand)).toEqual([]);
	});

	it("returns [] for empty text", () => {
		const brand = makeBrand({ banned_phrases: ["x"] });
		expect(detectBannedPhrases("", brand)).toEqual([]);
	});

	it("substring match (no word boundaries)", () => {
		const brand = makeBrand({ banned_phrases: ["cat"] });
		expect(detectBannedPhrases("scattered concatenation", brand)).toEqual(["cat"]);
	});
});

describe("assembleBrandSystemBlock", () => {
	it("produces a block with name + positioning", () => {
		const brand = makeBrand({ name: "EmDash", positioning: "Plain language." });
		const block = assembleBrandSystemBlock(brand);
		expect(block).toContain("# Brand: EmDash");
		expect(block).toContain("Plain language.");
	});

	it("includes locale when set", () => {
		const brand = makeBrand({ locale: "en" });
		const block = assembleBrandSystemBlock(brand);
		expect(block).toContain("_Locale: en_");
	});

	it("omits locale line when not set", () => {
		const brand = makeBrand();
		const block = assembleBrandSystemBlock(brand);
		expect(block).not.toContain("_Locale:");
	});

	it("renders voice attributes with intensity + description", () => {
		const brand = makeBrand({
			voice_attributes: [
				{ name: "Direct", intensity: 8, description: "say-what-you-mean" },
				{ name: "Sardonic" },
			],
		});
		const block = assembleBrandSystemBlock(brand);
		expect(block).toContain("**Direct**");
		expect(block).toContain("(8/10)");
		expect(block).toContain("say-what-you-mean");
		expect(block).toContain("**Sardonic**");
	});

	it("renders tone rules", () => {
		const brand = makeBrand({
			tone_rules: [{ context: "Errors", guidance: "State what broke" }],
		});
		const block = assembleBrandSystemBlock(brand);
		expect(block).toContain("_Errors_");
		expect(block).toContain("State what broke");
	});

	it("renders vocabulary preferred + avoid + rationale", () => {
		const brand = makeBrand({
			vocabulary: [
				{ preferred: "ship", avoid: ["deliver", "deploy"], rationale: "Action over process" },
			],
		});
		const block = assembleBrandSystemBlock(brand);
		expect(block).toContain('**"ship"**');
		expect(block).toContain("avoid: deliver, deploy");
		expect(block).toContain("Action over process");
	});

	it("renders banned phrases", () => {
		const brand = makeBrand({ banned_phrases: ["best in class"] });
		const block = assembleBrandSystemBlock(brand);
		expect(block).toContain("Never use");
		expect(block).toContain('"best in class"');
	});

	it("renders examples with good/bad/rationale", () => {
		const brand = makeBrand({
			examples: [{ good: "Shipped: X", bad: "Excited to announce X", rationale: "Verb-first" }],
		});
		const block = assembleBrandSystemBlock(brand);
		expect(block).toContain('Good: "Shipped: X"');
		expect(block).toContain('Bad: "Excited to announce X"');
		expect(block).toContain("Verb-first");
	});

	it("renders notes when present", () => {
		const brand = makeBrand({ notes: "More context here." });
		const block = assembleBrandSystemBlock(brand);
		expect(block).toContain("## Notes");
		expect(block).toContain("More context here.");
	});

	it("omits empty optional sections", () => {
		const brand = makeBrand();
		const block = assembleBrandSystemBlock(brand);
		expect(block).not.toContain("## Voice attributes");
		expect(block).not.toContain("## Tone rules");
		expect(block).not.toContain("## Vocabulary");
		expect(block).not.toContain("## Never use");
		expect(block).not.toContain("## Examples");
		expect(block).not.toContain("## Notes");
	});
});
