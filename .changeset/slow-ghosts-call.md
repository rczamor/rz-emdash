---
"emdash": minor
---

**M4 of the autonomous-agent harness roadmap — SSE streaming backend.**

`streamRunEvents(runId, sinceOrdinal, ctx)` returns a Web `Response` with `text/event-stream` body. Backfills events from storage on subscribe (since `sinceOrdinal`), then live-pushes events as the loop persists them. Auto-closes on terminal events (`run-completed`, `run-failed`, `run-cancelled`).

`notifyRun(event)` is called by the harness loop after every persisted event, fanning out to all active subscribers in the same isolate via a globalThis-keyed registry. Cloudflare Workers caveat documented: cross-isolate broadcast requires a Durable Object; the polling fallback (`runs.events?since_ordinal=`) remains correct in all cases.

`streamRunEvents` is exported from `@emdash-cms/plugin-runs` for consumers to wire into a custom Astro route. The standard plugin route framework returns JSON only; SSE needs a raw `Response` and is therefore a downstream-of-package wiring decision (a future admin live page lands the route).

Verification: 5 stream tests (backfill ordering, since_ordinal filter, content-type header, live notify after backfill, dedup of seen-during-backfill events). 58 tests total in runs plugin.
