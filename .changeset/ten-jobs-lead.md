---
"emdash": minor
"@emdash-cms/plugin-llm-router": patch
---

**M1 of the autonomous-agent harness roadmap — agent runs as first-class entities.**

Adds `@emdash-cms/plugin-runs`, the harness centerpiece. An agent run is now a persisted entity with a full message history, cost ledger, configurable per-run limits (iterations / tokens / USD / wallclock), and a checkpointed loop that survives process restarts. Each iteration is its own request — the loop re-enqueues itself on the scheduler — so the harness works on Cloudflare Workers without long-lived connections.

Routes (under `/_emdash/api/plugins/runs/`):

- `runs.start` — create a run from `{agent_id, prompt, max_iterations, max_tokens, max_usd, ...}`; first tick is enqueued automatically.
- `runs.get?id=` — full run state plus the recent event log.
- `runs.list?agent_id=&task_id=&status=&cursor=` — paginated lookup.
- `runs.cancel`, `runs.pause`, `runs.resume`, `runs.tick` — operator and scheduler control plane.
- `runs.events?run_id=&since_ordinal=` — tail the append-only event log.

The loop emits a typed event stream (`run-started`, `iteration-started`, `llm-call`, `tool-call`, `limit-hit`, `error`, `run-completed`, `run-failed`, `run-cancelled`) so M3's plan-mode UI and M4's live supervision UI can render history and stream updates without re-walking storage.

Tool invocation goes through internal RPC to `tools.invoke` so the per-agent allowlist + audit log are honored exactly as they would be from any other caller. Cost is rolled into the run with a heuristic USD estimator (replaced by per-model pricing in M5).

The legacy `@emdash-cms/plugin-llm-router/chat` route remains for backwards compat; its `chat-loop.ts` is now documented as a legacy synchronous path. Migration to the runs harness is sequenced for M3 when plan mode lands and the loop needs to grow with agent-aware compile + quota logic anyway.
