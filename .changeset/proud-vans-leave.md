---
"emdash": patch
---

Applies the same fail-closed agent-compile fix to `@emdash-cms/plugin-openrouter` that landed in `@emdash-cms/plugin-llm-router`. When an explicit `agent_id` is supplied but the agent is missing or inactive, the chat route now returns `Agent not found or inactive` instead of silently running anonymously without the agent's identity or tool allowlist. Also scopes the `useTools` fallback to the supplied `agent_id` so the model only sees tools the agent is permitted to call.
