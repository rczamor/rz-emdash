# @emdash-cms/plugin-design-system

EmDash plugin implementing **Google Labs' DESIGN.md spec** — the
design-system manifest format released April 2026 by the Stitch
team. Parse, validate, WCAG contrast check, Tailwind export, and
agent prompt injection.

Spec: <https://github.com/google-labs-code/design.md>
Formal: <https://github.com/google-labs-code/design.md/blob/main/docs/spec.md>

## Install

```ts
// astro.config.mjs
import { designSystemPlugin } from "@emdash-cms/plugin-design-system";

export default defineConfig({
	integrations: [emdash({ plugins: [designSystemPlugin()] })],
});
```

## How it works

DESIGN.md sits at your project root, Git-tracked. On build (or
manually after edits), POST the file's contents to the plugin's
`design.parse` route. The plugin parses + validates + caches the
result in plugin KV.

```bash
curl -X POST http://localhost:4321/_emdash/api/plugins/design-system/design.parse \
  -H "Content-Type: application/json" -H "Cookie: <admin>" \
  -d "$(jq -Rs '{source: .}' < DESIGN.md)"
# → { "ok": true, "report": { "findings": [...] } }
```

A typical CI hook:

```yaml
# .github/workflows/design-sync.yaml (excerpt)
- name: Sync DESIGN.md to emdash
  if: hashFiles('DESIGN.md') != ''
  run: |
    curl -fX POST "$EMDASH_URL/_emdash/api/plugins/design-system/design.parse" \
      -H "Content-Type: application/json" \
      -H "Cookie: $EMDASH_ADMIN_COOKIE" \
      -d "$(jq -Rs '{source: .}' < DESIGN.md)"
```

## Routes

```
POST  design.parse              body: { source } → parse + validate + cache
GET   design.get                cached parsed DESIGN.md
GET   design.tokens             resolved tokens (with {ref} substitution)
GET   design.validate           validation report
GET   design.systemPrompt       compact markdown block for prompt injection
GET   design.exportTailwind     tailwind.config.theme.extend fragment
POST  admin                     Block Kit
```

## Validation

Three levels of findings emitted by `design.validate`:

| Level     | Examples                                                                    |
| --------- | --------------------------------------------------------------------------- |
| `error`   | Duplicate level-2 section heading (spec rejects); contrast ratio below 3    |
| `warning` | Missing `name` in frontmatter; broken `{token.ref}` in body; contrast 3-4.5 |
| `info`    | Unknown body section heading (allowed by spec, but flagged for visibility)  |

The Block Kit admin at **Settings → Design system** renders the full
findings table.

## WCAG contrast

Best-effort check: pairs frontmatter colors named
`text*` / `foreground*` / `onX` against
`background` / `bg` / `surface` / `primary` / `secondary`. Computes
sRGB-space relative luminance and the 4.5 AA ratio. Reports anything
below as warning (or error below 3).

You can call `contrastRatio(fg, bg)` directly from the exported
helpers if you need to check arbitrary pairs.

## Tailwind export

```bash
curl http://localhost:4321/_emdash/api/plugins/design-system/design.exportTailwind
# → {
#     "ok": true,
#     "config": {
#       "theme": {
#         "extend": {
#           "colors": { "primary": "#ff6600", … },
#           "fontFamily": { "heading": ["Inter", "sans-serif"] },
#           "fontSize": { "h1": "2.25rem" },
#           "spacing": { "1": "4px", "2": "8px" },
#           "borderRadius": { "md": "0.5rem" }
#         }
#       }
#     }
#   }
```

Drop the `config` value into your `tailwind.config.js` directly:

```js
import config from "./tailwind-from-design-system.json" with { type: "json" };
export default { ...yourBase, ...config };
```

## Prompt injection

```ts
import { getDesignSystemPrompt } from "@emdash-cms/plugin-design-system/client";

const designBlock = await getDesignSystemPrompt();
const systemPrompt = `${agentSystemPrompt}\n\n${designBlock}\n\n${brandBlock}`;
```

The block is intentionally compact and structured so a model can
latch onto colors, typography, spacing, corner radii, and
do's/don'ts in sequence. Generated from the cached parsed DESIGN.md
(no parsing on each call).

## DESIGN.md example

```markdown
---
version: "1.0"
name: EmDash
description: Plain language, dense information, dark by default.

colors:
  background: "#0b0b0c"
  surface: "#1a1a1d"
  primary: "#ff6600"
  text: "#e8e8e8"
  textMuted: "#888"
  border: "#2a2a2d"

typography:
  body: { fontFamily: "Inter, system-ui, sans-serif", fontSize: "16px", lineHeight: "1.6" }
  heading: { fontFamily: "Inter", fontWeight: 600, lineHeight: "1.2" }
  mono: { fontFamily: "JetBrains Mono, ui-monospace, monospace", fontSize: "14px" }

spacing:
  "1": "4px"
  "2": "8px"
  "4": "16px"
  "8": "32px"

rounded:
  sm: "4px"
  md: "8px"
  lg: "12px"

components:
  button:
    primary:
      background: "{colors.primary}"
      color: "#fff"
      borderRadius: "{rounded.md}"
      padding: "{spacing.2} {spacing.4}"
---

## Overview

Plain language. Dense layouts over generous whitespace. Dark default
because the audience is engineers staring at terminals all day.

## Colors

Single-tone surfaces in three depths (background → surface → border)
with one warm accent (primary).

## Typography

Inter for everything except code, JetBrains Mono in monospace
contexts. No display fonts.

## Do's and Don'ts

- ✅ Lead with the work (verbs first)
- ✅ Use the primary colour for one CTA per surface
- ❌ Hero gradients
- ❌ Drop shadows above 1 layer of depth
- ❌ Animation that lasts more than 200ms
```

## Roadmap

- Live-preview each token visually in the admin (color swatches,
  font samples)
- Auto-watch a path (`process.cwd() + "/DESIGN.md"`) and re-parse on
  change
- Component property resolution beyond depth-1 token refs (cross-component)
- Dark/light variant frontmatter (`colors.dark`, `colors.light`)
