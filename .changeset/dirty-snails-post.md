---
"emdash": minor
---

**M9 of the autonomous-agent harness roadmap — validation gates pre-publish.**

A pluggable validator registry on the runs plugin: `registerValidator`, `unregisterValidator`, `listValidators`, `runValidators`. Validators receive a `ValidatorContext { collection, id, data, plugin }` and return `ValidationFinding[]`. The aggregator returns `{ ok, findings }`; `ok = false` when any finding has `severity: "fail"`.

Default seo validator ships with the runs plugin and registers at module load (idempotent). Heuristics: missing title (fail), out-of-range title length (warn), missing description (warn), oversize slug (warn), short body (warn), missing/multiple `<h1>` (warn). Brand and moderation validators are intentionally **not** here — they belong with their owning plugins (`@emdash-cms/plugin-brand`, `@emdash-cms/plugin-ai-moderation`); a follow-up wires them.

A validator that throws produces a `warn` finding (does not block); the registry never fails closed on validator bugs since they're observability, not policy.

New route: `runs.validate { collection, id?, data }` returns the `ValidationReport`. Approvers, agents, and pre-publish hooks can all call it.

Verification: 13 new tests covering registry behavior (sort, replace, throw-handling, empty-set), aggregator semantics, and the default seo validator. 85 tests total in runs plugin; 22 suites / 727 tests across the plugin tier.
