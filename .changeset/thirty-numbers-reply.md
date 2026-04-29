---
"@emdash-cms/plugin-tools": minor
---

**M2 of the autonomous-agent harness roadmap — content/media/web/scoring tool surface.**

Adds 10 new built-in tools so agents can actually do CMS work, not just read it:

- `content_create`, `content_update`, `content_publish`, `content_schedule`, `content_delete` — content writes, with M3 approval gates baked in (`content_publish` always pauses, `content_update` pauses on already-published targets, deletes always pause).
- `media_upload`, `media_delete` — media writes (upload by `source_url` or `bytes_base64`).
- `web_fetch` — text-body fetch with truncation, subject to per-agent host allowlist + SSRF.
- `seo_score`, `readability_score` — pure scoring tools (no caps, no I/O), used by M9 validators.

Approval gates surface as `{ ok: false, paused_for_human: { kind: "tool-approval", tool, args, reason } }`, which the runs harness already understands (M3 wires the human side).

Verification: 19 new tests, 53 total in `@emdash-cms/plugin-tools`.
