# @emdash-cms/plugin-langfuse

Langfuse integration for EmDash agentic workflows. Traces, scores,
dataset runs, prompt management. Works with self-hosted Langfuse
(e.g. the instance already running on your VPS) or Langfuse Cloud.

## Install

```ts
// astro.config.mjs
import { langfusePlugin } from "@emdash-cms/plugin-langfuse";

export default defineConfig({
	integrations: [emdash({ plugins: [langfusePlugin()] })],
});
```

## Configure

Three secrets, set as env vars on the EmDash server:

```bash
LANGFUSE_HOST=https://cloud.langfuse.com
# or for self-hosted:
LANGFUSE_HOST=http://langfuse-web:3000

LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
```

Or POST to the plugin to store in plugin KV:

```bash
curl -X POST .../langfuse/settings.setKeys \
  -d '{"host":"http://langfuse-web:3000","publicKey":"pk-lf-…","secretKey":"sk-lf-…"}'
```

## Routes

```
GET   status
POST  trace                  body: { traceId?, name?, userId?, metadata?, tags?, input?, output? }
POST  generation             body: { traceId, generationId?, name?, model?, input?, output?, usage? }
POST  score                  body: { traceId, name, value, comment? }
GET   prompts.get?name=&label=&version=
POST  datasets.items         body: { dataset }
POST  settings.setKeys
GET   settings
POST  admin
```

## Automation actions

Three new action types for routines:

### `langfuse:trace`

Submit a trace from any routine context. Useful as a manual override
when you need richer metadata than the OpenRouter cost-recorder.

```json
{
	"type": "langfuse:trace",
	"name": "task-{event.task.id}-completed",
	"userId": "agent:{event.task.assignee}",
	"taskId": "{event.task.id}",
	"tags": ["agentic", "{event.task.target_collection}"],
	"input": "{event.task.goal}",
	"output": "{event.task.output}"
}
```

### `langfuse:score`

Score a trace — fire on `task:reviewed` to attach approve/reject
decisions:

```json
{
	"id": "score-on-review",
	"trigger": { "on": "task:reviewed" },
	"filter": { "exists": { "path": "event.task.metadata.langfuse_trace_id" } },
	"actions": [
		{
			"type": "langfuse:score",
			"traceId": "{event.task.metadata.langfuse_trace_id}",
			"name": "review",
			"value": "{event.decision}"
		}
	]
}
```

### `langfuse:get-prompt`

Fetch a versioned prompt and stash in KV for downstream actions:

```json
{
	"type": "langfuse:get-prompt",
	"name": "blog-writer-system",
	"label": "production",
	"kvKey": "prompt:blog-writer"
}
```

Combine with the existing `llm:chat` action (which pulls from KV via
the tokens resolver) for prompt-managed agents.

## Auto-tracing via the provider-agnostic event bus

Langfuse doesn't depend on OpenRouter. Any LLM gateway plugin
(OpenRouter, LiteLLM, a direct Anthropic SDK wrapper, …) dispatches
three provider-agnostic events into the Automations engine:

```
llm:call-started     payload: { provider, model, messages, tools?, taskId?, agentId?, iteration, startedAt }
llm:call-finished    payload: { provider, model, input, output, usage, taskId?, agentId?, durationMs, finishReason? }
llm:call-failed      payload: { provider, model, taskId?, agentId?, iteration, error, durationMs }
```

Langfuse subscribes via routine — no code coupling. Drop this routine
in to auto-trace every LLM call regardless of which provider plugin
emitted it:

```json
{
	"id": "auto-trace-llm",
	"name": "Auto-trace every LLM call to Langfuse",
	"trigger": { "on": "llm:call-finished" },
	"actions": [
		{
			"type": "langfuse:trace",
			"name": "{event.provider}/{event.model}",
			"userId": "agent:{event.agentId|default:system}",
			"taskId": "{event.taskId}",
			"tags": ["{event.provider}", "{event.model}"],
			"input": "{event.input|json}",
			"output": "{event.output|json}",
			"metadata": {
				"usage": "{event.usage|json}",
				"durationMs": "{event.durationMs}",
				"finishReason": "{event.finishReason}"
			}
		}
	]
}
```

POST it to the automations engine:

```bash
curl -X POST .../automations/routines.upsert \
  -H "Content-Type: application/json" \
  -d @auto-trace-llm.json
```

From that point on, every chat call from any registered LLM gateway
flows into Langfuse as a trace. Failures land via `llm:call-failed`
with `level: ERROR` if you also wire that.

This is what the user meant by "OpenRouter is just another tool that
can connect to Langfuse." OpenRouter is one provider; the contract
is the event shape, not the plugin coupling.

## Why no SDK?

The Langfuse JS SDK is fine but adds bundle weight and brings its
own fetch shim. The Public REST API is small and stable —
`@emdash-cms/plugin-langfuse/api` wraps the four endpoints we need
(`ingest`, `getPrompt`, `listDatasetItems`, `pingHealth`) directly.
If you need SDK features later (auto-flush batched ingestion,
streaming traces), swap; for current scale (<100 calls/min) direct
calls with `await` are fine.

## Admin

Block Kit page at **Settings → Langfuse** shows configured-or-not,
host, and the 25 most recent traces this plugin has dispatched.
Dashboard widget shows the latest 5.

## Roadmap

- Auto-trace every OpenRouter chat call (requires hook in
  openrouter/chat-loop.ts; the trace-id ↔ task-id link surfaces in
  Langfuse natively)
- Eval runner action: `langfuse:run-dataset` — fires the agent
  against every item in a dataset, posts traces + expected-output
  comparisons
- Prompt cache (avoid re-fetching the same prompt+label on every
  routine fire)
- Score-from-LLM-judge action: `langfuse:llm-judge` — submit a
  trace's output to a judge model with a rubric, post the score
