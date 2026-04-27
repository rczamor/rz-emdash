# @emdash-cms/plugin-scheduler

One-shot scheduled jobs for EmDash. Fills three gaps in core:

1. **Auto-publishing**: emdash has `scheduled_at` + a `scheduled` status,
   and a `findReadyToPublish` query — but **nothing in core actually
   transitions content from scheduled → published when the time comes**.
   Public queries auto-promote, but the DB status stays "scheduled" and
   the `content:afterPublish` hook never fires.
2. **Unpublish scheduling**: nothing native at all.
3. **One-shot scheduling**: `ctx.cron` only handles recurring expressions.

## Install

```ts
// astro.config.mjs
import { schedulerPlugin } from "@emdash-cms/plugin-scheduler";

export default defineConfig({
	integrations: [
		emdash({
			plugins: [schedulerPlugin()],
		}),
	],
});
```

The plugin schedules a once-per-minute tick on activation. On every
tick it:

1. Claims pending jobs whose `runAt` is now-or-past.
2. Runs each by job type.
3. Marks done / retries with exponential-ish backoff / fails terminally
   after `maxAttempts` (default 3).

## Job types

### `publish`

```ts
{
  "type": "publish",
  "payload": { "type": "publish", "payload": { "collection": "posts", "contentId": "abc123" } },
  "runAt": "2026-04-30T09:00:00Z"
}
```

Calls `ctx.content.update(collection, id, { status: "published" })`.

### `unpublish`

```ts
{
  "type": "unpublish",
  "payload": { "type": "unpublish", "payload": { "collection": "posts", "contentId": "abc123" } },
  "runAt": "2026-05-30T09:00:00Z"
}
```

### `automation`

Fires an automations routine on demand. Useful when you want a routine
that normally only fires on an event to also run at a fixed future
time.

```ts
{
  "type": "automation",
  "payload": { "type": "automation", "payload": { "routineId": "weekly-digest", "event": { "ad-hoc": true } } },
  "runAt": "2026-05-01T15:00:00Z"
}
```

### `custom`

Calls a handler registered via `@emdash-cms/plugin-scheduler/registry`.

```ts
import { registerJobHandler } from "@emdash-cms/plugin-scheduler/registry";

registerJobHandler("audit:purge-old", async (data, ctx) => {
	const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
	// ... query your storage and delete entries older than cutoff ...
});
```

```json
{
	"type": "custom",
	"payload": { "type": "custom", "payload": { "handler": "audit:purge-old" } },
	"runAt": "2026-05-01T03:00:00Z"
}
```

## Auto-jobs from content fields

The plugin watches `content:afterSave` for two field conventions:

| Source field                      | Action                                                                       |
| --------------------------------- | ---------------------------------------------------------------------------- |
| `scheduled_at` (or `scheduledAt`) | Schedules a `publish` job at that time, if status is not already "published" |
| `unpublish_at` (or `unpublishAt`) | Schedules an `unpublish` job at that time                                    |

Existing pending jobs sourced from the same content item are canceled
first, so editing the schedule on a content item does what you'd
expect (no zombie publish from an earlier scheduled_at).

This means **content scheduling Just Works** — set `scheduled_at` in
your content edit form, and at that time the status flips to
"published" and emdash's normal `content:afterPublish` hook chain
fires. Same for `unpublish_at` to take something offline.

## API routes

```
GET   /_emdash/api/plugins/scheduler/jobs.list?status=pending&type=publish&limit=100
GET   /_emdash/api/plugins/scheduler/jobs.get?id=<id>
POST  /_emdash/api/plugins/scheduler/jobs.create     body: CreateJobInput
POST  /_emdash/api/plugins/scheduler/jobs.cancel     body: { id }
POST  /_emdash/api/plugins/scheduler/jobs.runNow     body: { id }   — force immediate execution
```

## Admin

A Block Kit page at **Settings → Scheduler** shows pending/running/
done/failed counts and the 50 most recent jobs. The dashboard widget
shows the next 5 pending jobs.

## Roadmap

- Bulk reschedule operation in admin.
- Visualisation of upcoming jobs on a timeline.
- Integration with the automations plugin so `scheduler:job:done` and
  `scheduler:job:failed` become first-class trigger names.
