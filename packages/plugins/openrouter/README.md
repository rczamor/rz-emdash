# @emdash-cms/plugin-openrouter

Connect EmDash to any LLM (Anthropic, OpenAI, Google, Mistral, Llama,
…) through [OpenRouter](https://openrouter.ai). One API key, many
providers.

## Install

```ts
// astro.config.mjs
import { tokensPlugin } from "@emdash-cms/plugin-tokens";
import { automationsPlugin } from "@emdash-cms/plugin-automations";
import { openrouterPlugin } from "@emdash-cms/plugin-openrouter";

export default defineConfig({
  integrations: [
    emdash({
      plugins: [tokensPlugin(), automationsPlugin(), openrouterPlugin()],
    }),
  ],
});
```

OpenRouter depends on automations (to register `llm:*` action types)
and tokens (so prompts can use `{event.content.title}` etc. inside
automations). Register all three.

## Configure the API key

Two options:

1. Set the `OPENROUTER_API_KEY` env var on the server.
2. Save it via the API:

   ```bash
   curl -X POST http://localhost:4321/_emdash/api/plugins/openrouter/settings.setKey \
     -H "Content-Type: application/json" -H "Cookie: <admin>" \
     -d '{"apiKey":"sk-or-v1-…"}'
   ```

   The key persists in plugin KV. Env var wins if both are set.

## Direct API routes

```
POST  /_emdash/api/plugins/openrouter/chat          { model?, messages, temperature?, max_tokens? }
POST  /_emdash/api/plugins/openrouter/complete      { model?, prompt }      → sugar over chat
POST  /_emdash/api/plugins/openrouter/embeddings    { model?, input }
GET   /_emdash/api/plugins/openrouter/models
GET   /_emdash/api/plugins/openrouter/settings
POST  /_emdash/api/plugins/openrouter/settings.save           { defaultModel?, defaultEmbeddingsModel? }
POST  /_emdash/api/plugins/openrouter/settings.setKey         { apiKey }
```

Defaults: `anthropic/claude-haiku-4-5` for chat,
`openai/text-embedding-3-small` for embeddings. Override per-request
in the body or globally via settings.

```bash
curl -X POST http://localhost:4321/_emdash/api/plugins/openrouter/complete \
  -H "Content-Type: application/json" -H "Cookie: <admin>" \
  -d '{"prompt":"Write a one-sentence tagline for a developer-focused CMS."}'
# → { "ok": true, "text": "EmDash: the CMS your AI agents already know how to use.", "response": {...} }
```

## Automation actions

Three new action types are registered with the automations plugin on
module load:

### `llm:chat`

```json
{
  "type": "llm:chat",
  "model": "anthropic/claude-sonnet-4-5",
  "system": "You are an editorial assistant.",
  "prompt": "Suggest 3 tags for: {event.content.title}\n\n{event.content.body}",
  "kvKey": "tag-suggestions:{event.content.id}",
  "maxTokens": 200
}
```

The `prompt` and `system` fields go through the tokens resolver, so
event payload is reachable. The result text is stored at the
KV key (also token-resolved) for downstream consumers — your site
code can read `await ctx.kv.get(...)` to surface it.

### `llm:summarize`

```json
{
  "type": "llm:summarize",
  "input": "{event.content.body}",
  "prompt": "Summarise this blog post in 2 sentences.",
  "kvKey": "summary:{event.content.id}",
  "maxTokens": 200
}
```

Convenience wrapper around `llm:chat`. Default `prompt` is
`Summarize the following content in 2-3 sentences. Be neutral and
factual.`

### `llm:embed`

```json
{
  "type": "llm:embed",
  "input": "{event.content.title} {event.content.body}",
  "kvKey": "embedding:{event.collection}:{event.content.id}"
}
```

Stores a `number[]` vector at the KV key. Pair with a similarity
search on read for "related posts" features.

## Worked example: auto-tag posts on publish

1. Create the routine via the automations API:

   ```json
   {
     "id": "auto-tag-on-publish",
     "name": "Suggest tags on publish",
     "trigger": { "on": "content:afterPublish" },
     "filter": { "eq": { "path": "event.collection", "value": "posts" } },
     "actions": [{
       "type": "llm:chat",
       "system": "You are an editorial assistant. Reply with 3 tags as a comma-separated list, lowercase, no extra text.",
       "prompt": "Title: {event.content.title}\n\nBody: {event.content.body}",
       "kvKey": "tag-suggestions:{event.content.id}",
       "maxTokens": 60
     }]
   }
   ```

2. On every published post, the LLM produces tags and stashes them
   in KV under `tag-suggestions:<contentId>`.

3. Your site's editor UI (or another routine) reads them and either
   auto-applies them or surfaces them as suggestions for human review.

## Importing the client directly

For ad-hoc calls outside automations, import the pure client:

```ts
import { chatCompletion, extractText } from "@emdash-cms/plugin-openrouter/client";

const response = await chatCompletion(
  {
    model: "anthropic/claude-haiku-4-5",
    messages: [{ role: "user", content: "Hello!" }],
  },
  { apiKey: process.env.OPENROUTER_API_KEY!, siteName: "My Site" },
);
console.log(extractText(response));
```

Pass your own `fetchImpl` if calling from inside another plugin's
sandboxed context (`ctx.http.fetch`).

## Admin

A Block Kit page at **Settings → OpenRouter** shows API-key status,
24-hour token usage, default models, and the 20 most recent calls.

## Cost & rate limits

OpenRouter is pay-as-you-go and exposes per-model pricing in the
`/models` endpoint. The plugin tracks token usage in plugin storage —
combine with the `models` endpoint's pricing data to compute spend.

## Roadmap

- Streaming responses (the OpenRouter API supports `stream: true`;
  the plugin passes through but doesn't currently surface SSE through
  the EmDash route layer).
- Per-collection model overrides.
- A "context" automation action that pulls related content via
  embeddings before the LLM call.
