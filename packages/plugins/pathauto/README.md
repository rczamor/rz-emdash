# @emdash-cms/plugin-pathauto

EmDash port of Drupal's Pathauto module. Generate content slugs from
token patterns, per collection.

## Install

```ts
// astro.config.mjs
import { tokensPlugin } from "@emdash-cms/plugin-tokens";
import { pathautoPlugin } from "@emdash-cms/plugin-pathauto";

export default defineConfig({
	integrations: [
		emdash({
			plugins: [tokensPlugin(), pathautoPlugin()],
		}),
	],
});
```

Pathauto reads `@emdash-cms/plugin-tokens/resolver` for the
templating engine, so register tokens too.

## Configure a pattern

```bash
curl -X POST http://localhost:4321/_emdash/api/plugins/pathauto/patterns.upsert \
  -H "Content-Type: application/json" -H "Cookie: <admin session>" \
  -d '{
    "collection": "posts",
    "pattern": "{publishedAt|date:YYYY}/{title}",
    "maxLength": 100,
    "lowercase": true,
    "onUpdate": "regenerate"
  }'
```

Once set, every save into `posts` runs through `content:beforeSave` and
the slug is rewritten:

```
publishedAt = 2026-04-25T18:32:00Z
title       = "Why I switched to EmDash"
            ↓
slug        = "2026/why-i-switched-to-emdash"
```

EmDash's built-in redirect-on-rename behaviour ([packages/core/src/database/repositories/redirect.ts](../../core/src/database/repositories/redirect.ts))
keeps old URLs working when the pattern changes a slug.

## Pattern syntax

Patterns use `@emdash-cms/plugin-tokens` syntax. The token context is
`{ content: <the saved content> }`, so anything in the content record
is reachable: `{title}`, `{publishedAt}`, `{author.name}`, etc.

Slash-separated path segments are slugified independently — useful so
`{title|slug}/{publishedAt|date:YYYY}` ends up as `the-title/2026`,
not `the-title-2026`.

| Pattern                            | Resulting slug           |
| ---------------------------------- | ------------------------ |
| `{title}`                          | `the-title`              |
| `{publishedAt\|date:YYYY}/{title}` | `2026/the-title`         |
| `{collection}/{title}`             | `posts/the-title`        |
| `{author.name\|slug}/{title}`      | `ada-lovelace/the-title` |

## On-update behaviour

| `onUpdate`               | Behaviour                                                                                                            |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `regenerate` _(default)_ | Always recompute slug from the pattern. Existing slugs get overwritten — emdash creates redirects from the old slug. |
| `preserve`               | Only generate when slug is empty. Existing slugs are kept.                                                           |

## Bulk regenerate

After a pattern change you can rewrite every existing item:

```bash
curl -X POST http://localhost:4321/_emdash/api/plugins/pathauto/regenerate \
  -H "Content-Type: application/json" -H "Cookie: <admin session>" \
  -d '{"collection": "posts"}'
# → { "ok": true, "updated": 42 }
```

The route paginates through the collection 100 items at a time. Each
slug change generates a redirect — old links don't break.

## Admin

Block Kit page at **Settings → Pathauto** lists all patterns. Editing
is via the API for now.

## Limits

- Patterns are per-collection, not per-language. A future v2 could honour
  emdash's i18n config and produce locale-prefixed slugs.
- Custom transliteration tables aren't shipped — relies on
  `String.prototype.normalize("NFKD")` which handles most accents.
