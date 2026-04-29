---
"emdash": minor
"@emdash-cms/plugin-tools": patch
---

**M3 of the autonomous-agent harness roadmap — plan mode + approval gates.**

Plan envelope: agents emit `<plan>...</plan>` JSON blocks in assistant messages. The harness extracts and parses them, pauses the run, and surfaces the plan to the operator via `runs.get`. On approve the run continues with a synthetic acknowledgement; on deny the run continues with a denial message so the model can revise.

Approval gates: tools that return `{ ok: false, paused_for_human }` envelopes pause the run with the originating tool_call recorded. On approve, `runs.approve` re-invokes the tool with `_force_execute: true` (bypassing the tool's own gate exactly once) and appends the real result to message_history. On deny, a synthetic tool result `{ ok: false, error: "denied: <reason>" }` is appended.

Routes: `runs.approve { id, approval_token? }`, `runs.deny { id, reason? }`. Approval tokens are single-use, generated when the run pauses, validated and cleared on approve.

Gate evaluator: `shouldGate({tool, current_cost_usd, estimated_step_cost_usd, config})` combines per-agent rules with the defaults (publish/delete/media_delete + $1 unattended-cost ceiling). Configurable via `RunGateConfig.always_gate`, `never_gate`, `max_usd_unattended`.

M2 tools updated: `content_publish`, `content_delete`, `media_delete`, and `content_update` (on published targets) now check `_force_execute` before pausing — the harness sets this flag on the resume path so the gate fires exactly once per approval cycle.

Verification: 24 new tests across `m3-plan.test.ts` and `m3-loop.test.ts`. Plugin tier all green.
