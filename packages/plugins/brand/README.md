# @emdash-cms/plugin-brand

Editorial voice / tone / vocabulary primitive for agentic content
management. Distinct from DESIGN.md (visual identity) and skills
(agent capabilities).

## Install

```ts
// astro.config.mjs
import { brandPlugin } from "@emdash-cms/plugin-brand";

export default defineConfig({
	integrations: [emdash({ plugins: [brandPlugin()] })],
});
```

## The Brand record

```ts
interface Brand {
	id: string;
	locale?: string; // optional; "en", "fr", etc.
	name: string;
	positioning: string; // who you are, in your own words
	voice_attributes: VoiceAttribute[];
	tone_rules: ToneRule[]; // when to be more/less formal, technical, etc.
	vocabulary: VocabEntry[]; // preferred terms + alternates to avoid
	banned_phrases: string[]; // hard-no list
	examples: PhraseExample[]; // good/bad pairs with rationale
	notes?: string;
	active: boolean;
}
```

Only one brand can be `active` per locale at a time. The
`brands.activate` endpoint deactivates peers automatically when you
flip the flag.

## Why a separate primitive?

Brand evolves frequently — quarterly review, A/B tests on positioning,
seasonal voice shifts. It also benefits from multi-language variants
(en, fr, es, …) without coupling to a single content collection
schema. So we store it in plugin storage (versioned, queryable, multi-row)
rather than as a flat `BRAND.md` file.

This contrasts with DESIGN.md which is **visual identity** (rare
changes, single artifact, value lies in version control), and with
skills which are **agent capabilities** (how to do task X — orthogonal
axis).

## Authoring

```bash
curl -X POST http://localhost:4321/_emdash/api/plugins/brand/brands.create \
  -H "Content-Type: application/json" -H "Cookie: <admin>" \
  -d '{
    "id": "default-en",
    "locale": "en",
    "name": "EmDash voice",
    "positioning": "We build infra for builders. Plain language, no theatre.",
    "voice_attributes": [
      { "name": "Direct", "intensity": 8 },
      { "name": "Sardonic but kind", "intensity": 6 },
      { "name": "Specific", "intensity": 9, "description": "Concrete examples over abstractions" }
    ],
    "tone_rules": [
      { "context": "Error messages", "guidance": "State what went wrong, what to do, no apology theatre" },
      { "context": "Marketing copy", "guidance": "Lead with the work, not the company" }
    ],
    "vocabulary": [
      { "preferred": "ship", "avoid": ["deliver", "deploy"], "rationale": "Action over process" },
      { "preferred": "engineer", "avoid": ["resource", "developer rockstar"] }
    ],
    "banned_phrases": ["best in class", "synergy", "moving forward"],
    "examples": [
      { "good": "Shipped: persistent agent memory.", "bad": "We are excited to announce a new feature for persistent memory.", "rationale": "Verb-first, factual" }
    ],
    "active": true
  }'
```

## Prompt injection (the killer feature)

```ts
import { getActiveBrand, assembleBrandSystemBlock } from "@emdash-cms/plugin-brand/client";

// Inside an OpenRouter / Agents callsite
const brand = await getActiveBrand({ locale: "en" });
const brandBlock = brand ? assembleBrandSystemBlock(brand) : "";
const systemPrompt = `${agentSystemPrompt}\n\n${brandBlock}`;
```

`assembleBrandSystemBlock` produces a compact markdown block:

```markdown
# Brand: EmDash voice

_Locale: en_

## Positioning

We build infra for builders. Plain language, no theatre.

## Voice attributes

- **Direct** _(8/10)_
- **Sardonic but kind** _(6/10)_
- **Specific** _(9/10)_ — Concrete examples over abstractions

## Tone rules

- _Error messages_: State what went wrong, what to do, no apology theatre
- _Marketing copy_: Lead with the work, not the company

## Vocabulary

- Use **"ship"** (avoid: deliver, deploy) — Action over process
- Use **"engineer"** (avoid: resource, developer rockstar)

## Never use

- "best in class"
- "synergy"
- "moving forward"

## Examples

- Good: "Shipped: persistent agent memory." · Bad: "We are excited to announce…" — Verb-first, factual
```

## Rule-based check

For a fast pre-publish check (no LLM call):

```bash
curl -X POST .../brand/brands.check \
  -d '{"text":"Excited to announce best in class developer rockstars"}'
# → { "ok": false, "offending": ["best in class"], "brandId": "default-en" }
```

This catches exact substring matches against the banned list. For
paraphrase detection, write an automation routine that calls
`llm:chat` with the brand block as system prompt and the draft as
user — that's the LLM-judge pattern.

## Admin

Block Kit page at **Settings → Brand**: list brands, see voice/vocab/
banned counts, activate or delete. Authoring still happens via the
API today — the editing UI is roadmap.

## Roadmap

- Block Kit form for editing voice attributes / vocab / tone rules
  in admin
- A/B variants — tag brands with `experiment_group`, route a fraction
  of agent runs to variant
- Auto-injection in OpenRouter chat-loop (currently the caller has
  to assemble the brand block — could be a flag like
  `injectBrand: true` on `llm:agent` actions)
- Markdown export to a `brand-<id>.md` file for git tracking
