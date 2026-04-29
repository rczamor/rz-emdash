---
"emdash": minor
"@emdash-cms/plugin-langfuse": minor
---

**M5 of the autonomous-agent harness roadmap — auto-Langfuse + cost summary.**

Langfuse: on `plugin:install`, the Langfuse plugin idempotently seeds three default routines into the automations storage:
1. `run:started → langfuse:trace` (open the trace)
2. `llm:call-finished → langfuse:generation` (per LLM call)
3. `run:completed → langfuse:score` (close the trace)

Operators install Langfuse, set their keys, and traces appear without further config. The `langfuse:*` actions live in this plugin's existing actions registry; the routines just bind events to them.

Cost summary: new route `runs.usageSummary?period=24h|7d|30d|all&group_by=agent|task|model|status` aggregates run cost server-side. Returns `{ totals, buckets[] }` sorted by USD desc. Pure-function aggregator (`aggregateUsage`) is exported so admin pages can also slice the data client-side without an extra round-trip.

Verification: 9 new tests covering period cutoffs, bucket aggregation, missing-task fallback. Plugin tier all green.
