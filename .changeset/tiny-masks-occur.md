---
"@emdash-cms/plugin-agents": minor
"@emdash-cms/plugin-tools": minor
---

**M8 of the autonomous-agent harness roadmap — skills as progressive disclosure.**

Default agents now compile with a skill **index** (slug + name + first-paragraph summary) instead of the full bulk-inlined skill bodies. A "Writer" with 30 skills no longer blows the system-prompt context window on every call.

`Agent.bulk_load_skills?: boolean` opts back into the legacy behavior for cases where every skill needs to be in scope from the start (small skill sets, short bodies).

Two new tools in `@emdash-cms/plugin-tools`:
- `skill_list({ agent_id })` — returns the agent's index `[{slug, name, summary}]`.
- `skill_load({ agent_id, slug })` — fetches the full body for a single skill. Allowlist-enforced server-side: only skills listed in the agent's `skills` array can be loaded.

New route in `@emdash-cms/plugin-agents`: `GET agents.skill.get?agent_id=&slug=` powers `skill_load`.

`firstParagraph(body)` extractor caps summaries at 280 chars so a long opening paragraph doesn't undermine the savings.

Verification: 4 new tool tests; 8 agents tests still green.
