# @emdash-cms/plugin-automations

EmDash port of Drupal's Rules module — reframed as Claude-Code-routine-style
YAML/JSON specs. Triggers, filters, actions. Event-driven and cron-driven.

## Install

```ts
// astro.config.mjs
import { tokensPlugin } from "@emdash-cms/plugin-tokens";
import { automationsPlugin } from "@emdash-cms/plugin-automations";

export default defineConfig({
  integrations: [
    emdash({
      plugins: [tokensPlugin(), automationsPlugin()],
    }),
  ],
});
```

## Routine spec

A routine is a JSON document. Fields:

| Field         | Required | Notes |
|---------------|----------|-------|
| `id`          | Yes      | Slug-style identifier, unique across routines |
| `name`        | Yes      | Human-readable label |
| `description` | No       | Free text |
| `enabled`     | No       | Defaults to `true` |
| `trigger`     | Yes      | What fires the routine — see below |
| `filter`      | No       | Structured DSL gating execution — see below |
| `actions`     | Yes      | Non-empty array of action specs — see below |

### Triggers

**Event triggers** match emdash hook events:

```json
{ "trigger": { "on": "content:afterPublish" } }
```

Supported `on` values: `content:beforeSave`, `content:afterSave`,
`content:beforeDelete`, `content:afterDelete`, `content:afterPublish`,
`content:afterUnpublish`, `media:beforeUpload`, `media:afterUpload`,
`comment:beforeCreate`, `comment:afterCreate`, `comment:afterModerate`,
`email:afterSend`.

**Cron triggers** use a 5-field cron expression:

```json
{ "trigger": { "on": "cron", "schedule": "0 9 * * 1" } }
```

The plugin reconciles registered cron schedules with stored routines on
plugin activation and on every routines.upsert / routines.delete.

### Filter DSL

Structured rather than expression-based, so it's diff-friendly and easy
for agents to author. Combine with `all`, `any`, `not`.

```json
{
  "filter": {
    "all": [
      { "eq":     { "path": "event.collection",          "value": "posts" } },
      { "eq":     { "path": "event.content.featured",    "value": true } },
      { "exists": { "path": "event.content.publishedAt" } },
      { "any": [
          { "in":   { "path": "event.content.tag", "values": ["new", "trending"] } },
          { "gte":  { "path": "event.content.viewCount", "value": 1000 } }
      ] }
    ]
  }
}
```

| Operator   | Shape |
|------------|-------|
| `eq`       | `{ path, value }` — deep equality |
| `ne`       | `{ path, value }` |
| `in`       | `{ path, values: [...] }` |
| `notIn`    | `{ path, values: [...] }` |
| `contains` | `{ path, value }` — substring on string values |
| `matches`  | `{ path, pattern, flags? }` — regex |
| `gt` / `gte` / `lt` / `lte` | `{ path, value }` — numeric |
| `exists`   | `{ path }` — true if value !== undefined |
| `all`      | `[Filter, …]` — every child must match |
| `any`      | `[Filter, …]` — at least one child matches |
| `not`      | `Filter` — invert |

`path` traverses the event payload via dot-notation. The root has shape
`{ event: <hook payload>, … }`. So for a `content:afterPublish` routine,
`event.content.title` is the post title.

### Actions

Actions run sequentially. If one throws, the routine stops and the error
is recorded on `routine.stats.lastError`.

#### `email`

```json
{ "type": "email", "to": "{site.email}",
  "subject": "[{site.name}] {event.content.title}",
  "body":    "Just published: {event.content.title}\n\n{event.content.summary}" }
```

Uses `ctx.email.send()` — routes through whichever email-provider plugin
is active (e.g. `@emdash-cms/plugin-resend`).

#### `webhook`

```json
{ "type": "webhook", "url": "https://hooks.slack.com/services/…",
  "method": "POST",
  "headers": { "Content-Type": "application/json" },
  "body": "{\"text\":\"New post: {event.content.title}\"}" }
```

Default `method` is `POST`; default `Content-Type` is `application/json`
when a body is present.

#### `log`

```json
{ "type": "log", "level": "info",
  "message": "{event.collection}/{event.content.id} published",
  "data": { "audit": "rule" } }
```

Levels: `debug | info | warn | error`. Goes through emdash's structured
logger.

#### `kv:set`

```json
{ "type": "kv:set", "key": "stats:lastPublishAt", "value": "{now|date:YYYY-MM-DDTHH:mm:ssZ}" }
```

Writes to plugin KV. String values are token-resolved before storage.

### Token context

Inside any string field of an action, you can reference:

| Path                | Resolves to |
|---------------------|-------------|
| `{event.…}`         | The hook payload, with all its fields |
| `{site.name}`       | The configured site name |
| `{routine.id}` / `{routine.name}` | The routine itself |
| `{now}`, `{uuid}`, `{timestamp}` | Dynamic helpers |
| Any token formatter (`\|date:YYYY-MM-DD`, `\|upper`, `\|default:NA`, …) | See [@emdash-cms/plugin-tokens](../tokens/README.md) |

## Manage via the API

```
GET   /_emdash/api/plugins/automations/routines.list
GET   /_emdash/api/plugins/automations/routines.get?id=<id>
POST  /_emdash/api/plugins/automations/routines.upsert     body: <Routine>
POST  /_emdash/api/plugins/automations/routines.delete     body: { id }
POST  /_emdash/api/plugins/automations/routines.test       body: { id, event? }
```

`routines.test` runs a routine immediately against a synthetic event
payload — useful while authoring.

## Worked examples

### 1. Slack on featured publish

```json
{
  "id": "slack-featured",
  "name": "Slack on featured publish",
  "trigger": { "on": "content:afterPublish" },
  "filter": {
    "all": [
      { "eq": { "path": "event.collection",       "value": "posts" } },
      { "eq": { "path": "event.content.featured", "value": true } }
    ]
  },
  "actions": [{
    "type": "webhook",
    "url": "https://hooks.slack.com/services/T000/B000/XXX",
    "body": "{\"text\":\"📣 *{event.content.title}* — https://{site.name}/{event.content.slug}\"}"
  }]
}
```

### 2. Weekly digest cron

```json
{
  "id": "weekly-digest",
  "name": "Weekly content digest",
  "trigger": { "on": "cron", "schedule": "0 9 * * 1" },
  "actions": [
    { "type": "log",  "message": "Weekly digest fired at {now|date:YYYY-MM-DD HH:mm}" },
    { "type": "email",
      "to": "team@example.com",
      "subject": "{site.name} weekly digest",
      "body":    "Compiled at {now|date:YYYY-MM-DD}." }
  ]
}
```

### 3. Auto-tag short posts

```json
{
  "id": "tag-shorts",
  "name": "Auto-tag posts under 200 words as 'short'",
  "trigger": { "on": "content:beforeSave" },
  "filter": {
    "all": [
      { "eq":  { "path": "event.collection", "value": "posts" } },
      { "lt":  { "path": "event.content.wordCount", "value": 200 } },
      { "not": { "contains": { "path": "event.content.tags", "value": "short" } } }
    ]
  },
  "actions": [
    { "type": "log", "message": "Would tag {event.content.id} as 'short' (todo: implement content:update action)" }
  ]
}
```

The `content:update` action is on the roadmap; today the engine ships
with email / webhook / log / kv:set only. Extend by forking the plugin's
`actions.ts`.

## Custom action types (pluggable registry)

The action registry is exported at `@emdash-cms/plugin-automations/registry`.
Register your own action type at module-load time:

```ts
// In another plugin's astro.config.mjs (or a tiny init file imported
// from there). Must run before the rules plugin handles its first
// routine — registering at module-load time satisfies that.

import { registerAction } from "@emdash-cms/plugin-automations/registry";
import type { Action } from "@emdash-cms/plugin-automations";
import { resolveTokens } from "@emdash-cms/plugin-tokens/resolver";

interface SlackAction extends Action {
  type: "slack";
  channel: string;
  message: string;
}

registerAction<SlackAction>("slack", async (action, tokenCtx, ctx) => {
  if (!ctx.http) throw new Error("network:fetch missing");
  const message = await resolveTokens(action.message, tokenCtx);
  await ctx.http.fetch(process.env.SLACK_WEBHOOK_URL!, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ channel: action.channel, text: message }),
  });
});
```

Routines can now reference `{"type": "slack", "channel": "#editorial", "message": "..."}` like any built-in action.

**Sandboxing constraint.** The registry is a module-scoped singleton.
It works across all plugins running in the same process (the trusted-
mode default). It does NOT cross V8 isolate boundaries — sandboxed
plugins each get their own copy of this module and therefore their
own (empty-by-default) registry. Until emdash exposes a runtime
cross-isolate plugin API, custom actions only work in trusted mode.

## Admin UI

A Block Kit page at **Settings → Automations** lists every routine. Per-row
actions:

- **Enable / Disable** — flips `enabled`. For cron routines this also
  reschedules / cancels the cron task.
- **Test** — fires the routine immediately against a synthetic
  `{ _testFire: true }` event payload. Useful while authoring.

By design, you can't *create* or *edit* routines in the UI — that's an
agent's job via the routines.upsert API. The UI is for visibility and
on/off control.

## Roadmap

- More built-in actions: `content:update`, `content:create`,
  `media:delete`, `email:template-send`.
- Cross-isolate action registry once emdash exposes a runtime plugin
  API.
- Per-routine concurrency / dedupe windows.
