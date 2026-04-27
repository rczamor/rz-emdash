# @emdash-cms/plugin-tasks

The **Task primitive** for agentic content management. A task is a unit
of work: goal, optional target entity, polymorphic assignee, state
machine, append-only activity log, and cost ledger. The keystone of
the agentic CMS framework.

## Install

```ts
// astro.config.mjs
import { automationsPlugin } from "@emdash-cms/plugin-automations";
import { tasksPlugin } from "@emdash-cms/plugin-tasks";

export default defineConfig({
	integrations: [
		emdash({
			plugins: [automationsPlugin(), tasksPlugin()],
		}),
	],
});
```

The plugin imports `@emdash-cms/plugin-automations/dispatch` to fire
`task:*` lifecycle events, so the Automations plugin must be
registered alongside.

## The Task

```ts
interface Task {
	id: string;
	parent_id?: string;
	goal: string; // 1-line objective
	description?: string; // longer brief

	// Optional content target
	target_collection?: string;
	target_id?: string; // existing item, or null = create-new

	// Polymorphic assignee — "human:<userSlug>" or "agent:<agentSlug>"
	assignee?: string;
	created_by: string;

	status:
		| "backlog"
		| "in_progress"
		| "pending_review"
		| "approved"
		| "rejected"
		| "published"
		| "cancelled";

	deadline?: string;
	publish_at?: string;
	depends_on?: string[];

	output?: Record<string, unknown>;

	cost: { tokensIn: number; tokensOut: number; usd?: number; calls: number };
	activity: ActivityEntry[]; // append-only

	created_at: string;
	updated_at: string;
}
```

## State machine

```
backlog ──────► in_progress
in_progress ──► pending_review | cancelled
pending_review ► approved | rejected | in_progress
rejected ─────► in_progress | cancelled
approved ─────► published | rejected | in_progress (revision)
published ────► in_progress (revision)
cancelled ────► (terminal)
```

Transitions outside this map throw. Use the `tasks.transition` route;
the engine validates the move and logs both old and new status to
`task.activity[]`.

## Lifecycle events

Every mutation dispatches into the Automations engine:

| Event                | When                                                            |
| -------------------- | --------------------------------------------------------------- |
| `task:created`       | After a new task is persisted                                   |
| `task:transitioned`  | After every state change                                        |
| `task:reviewed`      | When `pending_review → approved` or `pending_review → rejected` |
| `task:completed`     | When entering a terminal state (`published`, `cancelled`)       |
| `task:assigned`      | After assignee changes                                          |
| `task:commented`     | After a comment is added                                        |
| `task:cost-recorded` | After an LLM cost ledger entry                                  |

Routine spec example — auto-publish approved tasks via the scheduler:

```json
{
	"id": "auto-publish-approved",
	"trigger": { "on": "task:transitioned" },
	"filter": {
		"all": [
			{ "eq": { "path": "event.to", "value": "approved" } },
			{ "exists": { "path": "event.task.target_collection" } }
		]
	},
	"actions": [
		{
			"type": "webhook",
			"url": "https://your-host/_emdash/api/plugins/scheduler/jobs.create",
			"body": "{\"type\":\"publish\",\"payload\":{\"type\":\"publish\",\"payload\":{\"collection\":\"{event.task.target_collection}\",\"contentId\":\"{event.task.target_id}\"}},\"runAt\":\"{event.task.publish_at}\"}"
		}
	]
}
```

## API routes

```
POST  /_emdash/api/plugins/tasks/tasks.create        CreateTaskInput
GET   /_emdash/api/plugins/tasks/tasks.get?id=
GET   /_emdash/api/plugins/tasks/tasks.list?status=&assignee=&parent_id=&target_collection=&q=&limit=&cursor=
POST  /_emdash/api/plugins/tasks/tasks.update        UpdateTaskInput
POST  /_emdash/api/plugins/tasks/tasks.transition    { id, to, actor?, comment? }
POST  /_emdash/api/plugins/tasks/tasks.assign        { id, assignee, actor? }
POST  /_emdash/api/plugins/tasks/tasks.comment       { id, text, actor }
POST  /_emdash/api/plugins/tasks/tasks.delete        { id }

POST  /_emdash/api/plugins/tasks/cost.record         RecordCostInput
POST  /_emdash/api/plugins/tasks/quota.check         { taskId?, actor, estimatedTokensIn?, estimatedTokensOut? }
POST  /_emdash/api/plugins/tasks/quota.set           { dailyTokens?, taskTokens? }
```

## Provenance

Every mutation appends to `task.activity[]` with the actor who made
the change, a structured `data` payload, and a timestamp. Activity
types include `created`, `updated`, `transitioned`, `assigned`,
`commented`, `llm-call`, `tool-call`, `cost`, `reviewed`, `error`.

The activity log is the audit trail. Task admin renders it as a table.

## Cost & quotas

The OpenRouter plugin (and other LLM-calling plugins) call
`POST cost.record` after every LLM completion to accumulate cost on
the task. Two ledgers are maintained:

1. **Per-task** — `task.cost` field on the task itself.
2. **Per-day-per-actor** — keyed by `<YYYY-MM-DD>:<assignee>` in the
   `daily_cost` storage collection. The actor billed is the task's
   `assignee`, falling back to `created_by` if unassigned.

Both quotas are enforced via `POST quota.check` _before_ the LLM call:

```bash
curl -X POST .../tasks/quota.check \
  -d '{"taskId":"t_123","actor":"agent:writer-bot","estimatedTokensIn":500,"estimatedTokensOut":2000}'
# → { "ok": false, "reason": "Daily token quota exceeded …" }
```

Set the limits with `quota.set`:

```bash
curl -X POST .../tasks/quota.set -d '{"dailyTokens": 100000, "taskTokens": 5000}'
```

A limit of `0` means unlimited.

## Admin UI

Block Kit page at **Settings → Tasks**. List view with filters by
status and assignee. Click a task → detail view with:

- State summary (status, deadline, target, cost)
- Transition buttons (only transitions allowed by the state machine)
- Assign form
- Comment form
- Output JSON (if produced by an agent)
- Activity log table

Dashboard widget shows in-progress + pending-review counts.

## Sandbox compatibility

The `task:*` event dispatch goes through a direct cross-plugin import
of `@emdash-cms/plugin-automations/dispatch`. That works in trusted
mode (the recommended mode for this stack). In sandboxed mode each
plugin is a separate V8 isolate and the import would resolve to a
distinct engine instance with no routines registered. If you need
sandboxed Tasks + Automations + cross-plugin events, that requires a
runtime cross-isolate plugin API that emdash core does not yet
expose.

## Roadmap

- Bulk transitions / archive
- Sub-task creation from a parent
- Kanban board view (Block Kit primitives may need extension)
- Per-agent quota override on the assignee record (lands with the
  Agents plugin)
- Tool-call activity entries with execution time + result preview
  (lands with the Tools plugin)
