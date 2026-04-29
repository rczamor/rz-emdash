---
"emdash": major
---

**M0 of the autonomous-agent harness roadmap.**

Removes the standalone `@emdash-cms/plugin-openrouter` package. The OpenRouter gateway has lived as a driver inside `@emdash-cms/plugin-llm-router` for some time; the standalone duplicate produced parallel bug surfaces (fail-open agent compile, allowlist scope) that had to be patched twice. Consumers should migrate to `@emdash-cms/plugin-llm-router` — the routes (`/_emdash/api/plugins/llm-router/chat`, `embeddings`, `models`) and the OpenRouter driver are unchanged.

Adds `runId` and `traceId` to `PluginContext`, populated from `X-EmDash-Run-Id` and `X-EmDash-Trace-Id` request headers. Internal plugin RPC (`ctx.http.fetch` to `/_emdash/api/plugins/...`) automatically forwards these headers when present, so a single agent run is reconstructible across the chat-loop → tools.invoke → tasks.cost.record → langfuse path. External requests do not carry the headers.

Adds a storage-contract conformance test (`packages/core/tests/integration/plugins/storage-contract.test.ts`) that fails CI when any plugin uses the deprecated `filter:` key in `query()`/`count()` calls or passes unknown keys to `query()`.
