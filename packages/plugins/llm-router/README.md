# @emdash-cms/plugin-llm-router

Unified LLM gateway plugin with a driver registry. **One plugin,
multiple gateway providers.** Built-in drivers for OpenRouter,
TensorZero, and LiteLLM. Replaces the standalone `@emdash-cms/plugin-openrouter`
and `@emdash-cms/plugin-tensorzero` plugins.

## Why this shape

Each LLM gateway speaks roughly OpenAI-compatible HTTP. Building a
plugin per gateway duplicated the chat-loop, automation actions,
admin UI, and event emission — and forced "register only one"
constraints because action names collided.

Now: one plugin owns the cross-cutting concerns (chat-loop, llm:*
event emission, cost recording, agent context, admin UI). Drivers
implement the four-method `Driver` contract — `chatCompletion`,
`embeddings`, `listModels`, optional `nativeRoutes`. Adding a new
gateway means writing a driver file and re-exporting; the rest of
the system stays untouched.

## Install

```ts
// astro.config.mjs
import { llmRouterPlugin } from "@emdash-cms/plugin-llm-router";

export default defineConfig({
  integrations: [
    emdash({ plugins: [llmRouterPlugin()] }),
  ],
});
```

## Configure

Set env vars for whichever gateway you want active. The router
auto-detects in this order: TensorZero, OpenRouter, LiteLLM.
Override with `LLM_ROUTER_DRIVER`.

```bash
# Use TensorZero (auto-detected if HOST is set)
TENSORZERO_HOST=http://tensorzero:3000
TENSORZERO_API_KEY=...   # optional

# Use OpenRouter
OPENROUTER_API_KEY=sk-or-v1-...

# Use LiteLLM
LITELLM_HOST=http://litellm:4000
LITELLM_API_KEY=sk-...

# Force a specific driver regardless of env detection
LLM_ROUTER_DRIVER=openrouter
```

## Routes

### Common (provider-agnostic)

```
POST  chat             { model?, messages, … } + agent_id?, task_id?, useTools?
POST  complete         sugar: { model?, prompt }
POST  embeddings       { model?, input }
GET   models           list models from active driver
GET   status           { configured, driver, host, hasApiKey, availableDrivers, … }
GET   settings
POST  settings.save    { defaultModel?, defaultEmbeddingsModel? }
POST  admin            Block Kit
```

### Native (provider-specific)

Mounted at `native/<driver>/<route>` per registered driver. Today:

```
POST  native/tensorzero/inference     { function_name, variant_name?, episode_id?, input, params? }
POST  native/tensorzero/feedback      { inference_id|episode_id, metric_name, value, tags?, dryrun? }

POST  native/litellm/spend.logs
GET   native/litellm/key.info
```

OpenRouter has no native routes today (its features are all in the
chat completion request body — the OpenAI-compat path covers them).

Use the dispatcher route to hit native routes generically:

```bash
curl -X POST .../llm-router/native.dispatch \
  -d '{"driver":"tensorzero","route":"feedback","body":{"inference_id":"01J…","metric_name":"approval","value":1}}'
```

Or call the namespaced shortcut routes directly:

```bash
# Same call, different URL form (TBD in v2 — `/native/tensorzero/feedback` shortcut)
```

## Automation actions

Same surface as the old standalone plugins:

```
llm:chat          { model?, system?, prompt, agentId?, taskId?, useTools?, kvKey? }
llm:agent         { agentId, prompt, taskId?, kvKey? }
llm:summarize     { input, prompt?, model?, kvKey?, taskId? }
llm:embed         { input, model?, kvKey }
```

The **active driver** decides which gateway each call hits — your
routines never need to know which provider is in use.

## Provider-agnostic event emission

The chat-loop emits the same `llm:*` events regardless of driver:

```
llm:call-started     payload: { provider, model, messages, tools?, taskId?, agentId?, iteration, startedAt }
llm:call-finished    payload: { provider, model, input, output, usage, taskId?, agentId?, durationMs, finishReason? }
llm:call-failed      payload: { provider, model, taskId?, agentId?, iteration, error, durationMs }
```

`provider` is the driver id (`openrouter` / `tensorzero` / `litellm`).
The Langfuse plugin's auto-trace routine subscribes to
`llm:call-finished` and works without any driver-specific changes.

## Adding a new driver

```ts
// my-driver.ts
import { type Driver } from "@emdash-cms/plugin-llm-router/driver";

export const myDriver: Driver = {
  id: "myprovider",
  name: "My Provider",
  defaults: {
    chatModel: "their/model-id",
    embeddingsModel: "their/embed-model",
  },
  configFromEnv(env) {
    return {
      host: env.MYPROVIDER_HOST,
      apiKey: env.MYPROVIDER_API_KEY,
    };
  },
  detect(env) {
    return Boolean(env.MYPROVIDER_API_KEY);
  },
  build(config) {
    if (!config.apiKey) throw new Error("MyProvider: apiKey missing");
    const headers = { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" };

    return {
      chatCompletion: async (input, fetchImpl) => {
        const res = await fetchImpl(`${config.host}/chat/completions`, {
          method: "POST",
          headers,
          body: JSON.stringify(input),
        });
        if (!res.ok) throw new Error(`MyProvider chat ${res.status}`);
        return await res.json();
      },
      embeddings: async (input, fetchImpl) => { /* ... */ },
      listModels: async (fetchImpl) => { /* ... */ },
    };
  },
};
```

Register at module-load time (e.g. from your own plugin's sandbox-entry):

```ts
import { registerDriver } from "@emdash-cms/plugin-llm-router/driver";
import { myDriver } from "./my-driver";

registerDriver(myDriver);
```

The router picks it up automatically. If you want it to
auto-activate when its env var is set, return `true` from `detect()`.

## Migration from the old plugins

The standalone `@emdash-cms/plugin-openrouter` and `@emdash-cms/plugin-tensorzero`
plugins are deprecated in favour of this one. To migrate:

```diff
// astro.config.mjs
- import { openrouterPlugin } from "@emdash-cms/plugin-openrouter";
- import { tensorzeroPlugin } from "@emdash-cms/plugin-tensorzero";
+ import { llmRouterPlugin } from "@emdash-cms/plugin-llm-router";

  plugins: [
    // …
-   openrouterPlugin(),
-   tensorzeroPlugin(),
+   llmRouterPlugin(),
  ]
```

Env vars stay the same. Automation actions stay the same. Routes
move from `/openrouter/chat` → `/llm-router/chat` (or the new
namespace).
