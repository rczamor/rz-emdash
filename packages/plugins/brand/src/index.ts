/**
 * Brand Plugin for EmDash CMS — editorial voice / tone / vocabulary
 * as a first-class primitive.
 *
 * Why this is distinct from DESIGN.md and skills:
 *   - DESIGN.md is visual identity (colors, typography, spacing).
 *   - Skills are agent capabilities (how to do task X).
 *   - Brand is editorial: how the company sounds in writing — the
 *     positioning, voice attributes, vocabulary, banned phrases.
 *
 * Brand evolves frequently and benefits from versioning + review +
 * multi-language variants, so it lives in plugin storage rather than
 * a flat file.
 *
 * The OpenRouter / Agents plugins import the prompt-injection helper
 * (`assembleBrandSystemBlock`) and prepend the active brand to every
 * agent run.
 */

import type { PluginDescriptor } from "emdash";

export type {
	Brand,
	CreateBrandInput,
	PhraseExample,
	ToneRule,
	UpdateBrandInput,
	VocabEntry,
	VoiceAttribute,
} from "./types.js";

export function brandPlugin(): PluginDescriptor {
	return {
		id: "brand",
		version: "0.0.1",
		format: "standard",
		entrypoint: "@emdash-cms/plugin-brand/sandbox",
		options: {},
		storage: {
			brands: {
				indexes: ["active", "locale", "created_at"],
			},
		},
		adminPages: [{ path: "/brand", label: "Brand", icon: "speech" }],
	};
}
