# @emdash-cms/plugin-agents

Agent registry for EmDash. Identity files (OpenClaw-style split),
per-agent skills allowlist, per-agent tools allowlist, memory
partitioned by `agent_id`, model preferences, quota overrides.

## Install

```ts
// astro.config.mjs
import { agentsPlugin } from "@emdash-cms/plugin-agents";

export default defineConfig({
  integrations: [
    emdash({ plugins: [agentsPlugin()] }),
  ],
});
```

## The Agent

```ts
interface Agent {
  id: string;          // slug — referenced by tasks as "agent:<id>"
  name: string;
  role: string;        // "Writer", "Editor", "Researcher", …
  active: boolean;

  // Identity-as-files (OpenClaw pattern)
  identity: string;          // markdown — IDENTITY.md content
  soul?: string;             // markdown — values, voice; SOUL.md
  tools_md?: string;         // markdown — env-specific notes; TOOLS.md

  model: { primary: string; fallback?: string; temperature?: number; maxTokens?: number };

  skills: string[];          // slugs in the agent_skills content collection
  tools: string[];           // tool names from the Tools plugin / MCP catalog
  skills_collection?: string; // default "agent_skills"

  quotas?: { dailyTokens?: number; taskTokens?: number; dailyCalls?: number };
}
```

## Skills — content, not plugin storage

Per the framework decision: skills are a content collection, defined
in your `seed.json`. Each skill is a regular emdash content item with
fields like `name` and `body` (Portable Text or markdown). The agent
holds an allowlist of slugs; the plugin resolves bodies at runtime
when assembling a system prompt via `agents.compile`.

Recommended seed entry for the collection:

```json
{
  "slug": "agent_skills",
  "label": "Agent skills",
  "fields": [
    { "slug": "title", "label": "Name", "type": "string", "required": true },
    { "slug": "description", "label": "Trigger description", "type": "text" },
    { "slug": "body", "label": "Skill body", "type": "portableText" }
  ]
}
```

The skill format mirrors the [rczamor/rz-claude-code-skills](https://github.com/rczamor/rz-claude-code-skills)
pattern: persona sentence + principles + frameworks + Process. The
plugin doesn't enforce a specific shape — that's editorial.

## Identity files — OpenClaw-style split

```
IDENTITY.md   role, responsibilities, decision framework (the persona)
SOUL.md       values, voice, opinions (the editorial spine)
TOOLS.md      environment-specific notes — ssh hosts, CLI access, …
```

All three live as markdown text on the Agent row. Edit via the admin
form or the API. A future companion CLI will sync these between DB
and a `/agents/<slug>/` folder for git tracking.

## Memory

Partitioned by `agent_id`. The `memory` storage collection holds:

```ts
interface MemoryEntry {
  id: string;
  agent_id: string;          // partition key
  key: string;
  value: unknown;
  importance: number;        // 0..1
  source?: string;           // task id, event id, …
  tags?: string[];
  last_accessed_at: string;
  created_at: string;
}
```

Routes:

```
POST  memory.put              { agent_id, key, value, importance?, source?, tags? }
GET   memory.get?agent_id=&key=
GET   memory.list?agent_id=&limit=&cursor=
POST  memory.search           { agent_id, query?, tags?, importance_min?, limit? }
POST  memory.delete           { id } | { agent_id, key }
```

`memory.search` ranks by `importance * 0.7 + recency * 0.3`, where
recency = `1 / (1 + days_since_last_access / 30)`. The current
implementation is plain DB scoring; semantic search is provided by
the future `@emdash-cms/plugin-pgvector` plugin and can be combined
in caller code.

## Compile context (system-prompt assembly)

```
GET /_emdash/api/plugins/agents/agents.compile?id=writer-bot&memoryLimit=10
→ {
    agent: <Agent>,
    skills: [{ slug, name, body }, …],
    memories: [<MemoryEntry>, …]
  }
```

A helper in `@emdash-cms/plugin-agents/client` (`assembleSystemPrompt`)
turns this into a single markdown blob suitable for the OpenRouter
chat `system` message. The OpenRouter plugin will call this directly
when running a Task assigned to an agent.

## Quotas

`agent.quotas` overrides the Tasks-plugin global defaults
(`tasks/quota.set`). When the OpenRouter plugin checks quota, it
queries the agent first; if no override, falls back to the plugin
defaults.

## Admin

Block Kit page at **Settings → Agents**:

- List all agents (id, role, model, skills/tools counts, active)
- Per-row Edit / Activate-Deactivate / Delete
- New-agent form
- Edit-agent form covering identity, soul, model, skills, tools,
  quotas

Dashboard widget shows the count of active agents.

## Sandbox

Memory writes are high-frequency, so the plugin storage is the
right home — markdown files would force frequent DB↔file syncs.
Identity / soul / tools_md are stored as text on the agent row;
that's editable in admin AND can be exported to files for git
tracking.

In trusted mode the plugin co-runs with the rest of the stack.
Sandboxed mode would isolate per-agent storage to its isolate's
own KV — usable but loses cross-plugin compile context until
emdash core exposes a runtime cross-isolate plugin API.

## Roadmap

- `agents.sync-files` route: export identity files to
  `agents/<id>/IDENTITY.md|SOUL.md|TOOLS.md` for git tracking, and
  the inverse on rebuild
- Agent groups / teams (one Conductor coordinating Writer + Editor)
- Per-agent rate limiting (calls/sec) on top of token quotas
- Memory expiry policy (auto-decay importance over time)
