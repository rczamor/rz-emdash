# @emdash-cms/plugin-tokens

EmDash port of Drupal's Tokens module. Replace `{site.name}`,
`{user.email|upper}`, `{now|date:YYYY-MM-DD}` and similar patterns with
real values.

## Status: scope honesty

Drupal Tokens is most powerful when combined with hook_field_widget or
hook_entity_presave to resolve tokens on **any** field of any entity.
That kind of cross-cutting concern requires core integration that an
emdash plugin can't do alone.

What this package ships instead:

1. **A pure resolver utility** at `@emdash-cms/plugin-tokens/resolver`
   that any plugin or any user code can import. Plugins that want
   tokens (Webform email templates, future Pathauto patterns,
   Metatag-style title templates) call `resolveTokens()` themselves.
2. **A registered plugin descriptor** so emdash knows tokens are
   installed (cosmetic; gives the marketplace UI a row to show).

The first half is the useful one.

## Use the resolver

```ts
import { resolveTokens } from "@emdash-cms/plugin-tokens/resolver";

await resolveTokens("Hello {user.name|upper}!", { user: { name: "ada" } });
// → "Hello ADA!"

await resolveTokens("Posted {now|date:YYYY-MM-DD}", {});
// → "Posted 2026-04-25"

await resolveTokens("Subject: {form.title} — {submission.name|default:Anonymous}", {
	form: { title: "Contact" },
	submission: { name: "Ada" },
});
// → "Subject: Contact — Ada"
```

## Syntax

```
{path}                  dot-path lookup in the context object
{path|format}           lookup, then format
{path|format:arg}       formatter with one argument
{path|fmt1|fmt2:arg}    chained formatters
{{literal-braces}}      escape: emits {literal-braces}
```

### Dynamic paths

These resolve without a context entry:

| Path          | Value                            |
| ------------- | -------------------------------- |
| `{now}`       | a `Date` (use with `\|date:FMT`) |
| `{timestamp}` | Unix seconds                     |
| `{uuid}`      | Random UUID v4                   |

### Built-in formatters

| Formatter                  | Effect                                                            |
| -------------------------- | ----------------------------------------------------------------- |
| `upper` / `lower` / `trim` | String case                                                       |
| `default:fallback`         | Used when value is null/empty                                     |
| `truncate:N`               | Truncate to N chars + `…`                                         |
| `date:FORMAT`              | Format a Date or ISO string. Format tokens: `YYYY MM DD HH mm ss` |
| `slug`                     | Kebab-case ascii slug                                             |
| `json`                     | `JSON.stringify`                                                  |

### Custom formatters

```ts
await resolveTokens(
	"Price: {price|currency:USD}",
	{ price: 99.95 },
	{
		formatters: {
			currency: (v, code) =>
				new Intl.NumberFormat("en-US", {
					style: "currency",
					currency: code ?? "USD",
				}).format(Number(v)),
		},
	},
);
// → "Price: $99.95"
```

Custom formatters merge with the built-ins — pass only what you're adding.

## Why a plugin if it's mostly a function?

Two reasons:

1. **Discoverability.** Listing it in `astro.config.mjs` makes it
   greppable and obvious to the next person reading the config.
2. **Future expansion.** When emdash adds hooks or runtime APIs that
   benefit from a registered token registry, this descriptor becomes
   the place to wire them in.

The descriptor itself has zero hooks today. The whole package is
~200 LOC, half of which is JSDoc.
