# @emdash-cms/plugin-pgvector

Embedding storage + similarity search backed by Postgres pgvector
with HNSW indexing. **Postgres-only by design** — no SQLite fallback.

## Why Postgres-only

Half-good vector search is worse than no vector search. The plugin
opens its own `pg.Pool` against the same Postgres your emdash core
uses (via the standard `PG*` env vars), creates a dedicated table
with a `vector(N)` column, and builds an HNSW index. SQLite has no
performant equivalent worth shipping, and pretending it does would
ship false confidence.

## Install

```ts
// astro.config.mjs
import { pgvectorPlugin } from "@emdash-cms/plugin-pgvector";

export default defineConfig({
  integrations: [
    emdash({ plugins: [pgvectorPlugin()] }),
  ],
});
```

The plugin runs `CREATE EXTENSION IF NOT EXISTS vector` on install
and activate. **Your Postgres user needs CREATE EXTENSION
privileges** for the first init. After that, day-2 operation only
needs INSERT/SELECT.

If you can't grant CREATE EXTENSION, run it manually as superuser:

```sql
CREATE EXTENSION vector;
```

then start the plugin — schema/index creation is idempotent.

## Configuration

Single dimension per install, configurable via env var:

```bash
PGVECTOR_DIMENSION=1536   # default — OpenAI text-embedding-3-small / voyage-3-lite
PGVECTOR_DIMENSION=3072   # OpenAI text-embedding-3-large
PGVECTOR_DIMENSION=512    # voyage-lite-02
```

Postgres connection: `PGHOST` / `PGPORT` / `PGUSER` / `PGPASSWORD` /
`PGDATABASE` (same as emdash core, pg's standard env-var fallback).

## Schema

```sql
CREATE TABLE pgvector_embeddings (
  id                TEXT PRIMARY KEY,
  source_collection TEXT NOT NULL,
  source_id         TEXT NOT NULL,
  model             TEXT NOT NULL,
  dimension         INTEGER NOT NULL,
  embedding         vector(N),
  metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(source_collection, source_id, model)
);

-- HNSW with cosine distance — ideal for unit-normalised
-- embeddings (OpenAI / Anthropic / Voyage all unit-normalise).
CREATE INDEX pgvector_embeddings_hnsw_idx
  ON pgvector_embeddings
  USING hnsw (embedding vector_cosine_ops);
```

The `(source_collection, source_id, model)` unique constraint means
upserts are idempotent per source.

## Routes

```
POST  init                                  Re-run schema migration (idempotent)
POST  upsert                                { source_collection, source_id, model, embedding[], metadata? }
POST  search                                { embedding[], k?, source_collection?, metric? }
POST  search.byText                         { text, model?, k?, source_collection? }   (auto-embeds via openrouter)
POST  delete                                { source_collection, source_id, model? }
GET   list?source_collection=&limit=
GET   stats
POST  admin                                 Block Kit
```

`metric` accepts `cosine` (default), `l2`, `ip`. The HNSW index is
built for cosine; using a different metric still works but doesn't
use the index — falls back to a sequential scan.

## Wiring with the OpenRouter plugin

The cleanest pattern is two automation actions composed:

```json
[
  { "type": "llm:embed",
    "input": "{event.content.title} {event.content.body}",
    "kvKey": "embedding-buffer:{event.content.id}" },
  { "type": "webhook",
    "url": "/_emdash/api/plugins/pgvector/upsert",
    "body": "{ \"source_collection\": \"posts\", \"source_id\": \"{event.content.id}\", \"model\": \"openai/text-embedding-3-small\", \"embedding\": <KV-fetched> }" }
]
```

Or use the plugin's `search.byText` route, which embeds + searches
in one call:

```bash
curl -X POST http://localhost:4321/_emdash/api/plugins/pgvector/search.byText \
  -d '{"text":"how do plugins work?","k":5,"source_collection":"posts"}'
```

Requires the OpenRouter plugin to be configured with a working API
key.

## Auto-embed on save (recipe)

The plugin doesn't ship an auto-hook — that decision belongs to your
deployment. Two patterns:

**Pattern A — Routine via Automations:**

```json
{
  "id": "embed-on-save",
  "trigger": { "on": "content:afterSave" },
  "filter": { "eq": { "path": "event.collection", "value": "posts" } },
  "actions": [
    { "type": "llm:embed",
      "input": "{event.content.title} {event.content.body}",
      "kvKey": "embedding-buffer" }
  ]
}
```

(Followed by a webhook action to upsert into pgvector — left as an
exercise; the cleaner approach is to build a custom automation
action like `vector:upsert` that reads the buffer and POSTs the
upsert internally.)

**Pattern B — Custom action type:**

In your own plugin, register an automations action that bundles
embed + upsert in one step. See
`@emdash-cms/plugin-automations/registry`.

## Roadmap

- Multi-dimension support (separate tables, auto-routing by model)
- IVFFlat alternative for installs with limited HNSW build memory
- Bulk upsert (currently single-row only)
- Metadata filtering (`WHERE metadata->>'foo' = 'bar'` in search)
- An `auto-embed` config in plugin KV — collections + field-set to
  embed automatically on save
- A `vector_search` tool registration with the Tools plugin (so
  agents can semantically search content during a chat completion)
