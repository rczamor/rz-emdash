---
"emdash": minor
"@emdash-cms/plugin-tools": minor
---

**M7 of the autonomous-agent harness roadmap — agent dispatch + sub-runs.**

`agent_dispatch` tool: an agent can spawn a sub-run on another agent and pause awaiting its result. The new run inherits `parent_run_id`; the parent transitions to `paused` with `paused_for_human.kind: "awaiting-subrun"`.

The runs harness now recognizes `paused_for_subrun` envelopes from tool results and persists the parent appropriately. The `subrun-completed → resume parent` automation routine that auto-resumes is intentionally stubbed for M7 — a future milestone wires it. Operators can resume manually with the sub-run's final output for now.

Sub-run primitives (`packages/plugins/runs/src/sub-runs.ts`):
- `isAncestor(run, targetId, loadRun)` — cycle detection on dispatch.
- `runDepth(run, loadRun)` — bounded by `MAX_SUBRUN_DEPTH = 6`.
- `rollupCost(run, listChildren)` — transitive cost aggregation, computed not stored.

Verification: 8 new tests covering ancestor detection (including self-cycle), depth bounding, and cost rollup correctness with grandchildren. 75 tests total in runs plugin, 53 in tools.
