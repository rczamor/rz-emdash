/**
 * Tasks Plugin for EmDash CMS — the keystone of the agentic CMS framework.
 *
 * A Task is the unit of work: a goal, an optional target entity, a
 * polymorphic assignee (human or agent), a state machine, an
 * append-only activity log, and a cost ledger.
 *
 * State machine:
 *   backlog → in_progress → pending_review → approved → published
 *                       └→ cancelled    └→ rejected
 *
 * Polymorphic assignee:
 *   "human:<userSlug>"  — references an emdash user (admin notifications)
 *   "agent:<agentSlug>" — references the Agents plugin's registry
 *   "system"            — engine-internal
 *
 * Lifecycle events are dispatched into the Automations engine so
 * routines can react. Trigger names exposed:
 *
 *   task:created
 *   task:transitioned   (every state change)
 *   task:reviewed       (pending_review → approved | rejected)
 *   task:completed      (→ published terminal)
 *   task:assigned
 *   task:commented
 *   task:cost-recorded
 *
 * Provenance: every mutation appends to `task.activity[]` with the
 * actor who made the change. Cost: every llm-call recorded via
 * tasks.cost.record updates `task.cost` and appends an activity.
 *
 * Quotas (per-task and per-day-per-agent) are enforced by readers —
 * the OpenRouter plugin checks a quota helper before each LLM call
 * and the helper rejects if the cost ledger has exceeded the cap.
 *
 * For routes + Block Kit admin, see `sandbox-entry.ts`.
 */

import type { PluginDescriptor } from "emdash";

export type {
	ActivityEntry,
	ActivityType,
	Actor,
	AssignTaskInput,
	CommentTaskInput,
	CostLedger,
	CreateTaskInput,
	RecordCostInput,
	Task,
	TaskStatus,
	TransitionTaskInput,
	UpdateTaskInput,
} from "./types.js";

export {
	canTransition,
	allTransitions,
	isTerminal,
	STATUS_BADGE_COLORS,
	TERMINAL,
} from "./states.js";

export interface TasksPluginOptions {
	/**
	 * Default per-day token quota per assignee. 0 = unlimited.
	 * Enforced by the per-day quota helper exposed via the client export.
	 */
	defaultDailyTokenQuota?: number;
	/**
	 * Default per-task token quota. 0 = unlimited. Tasks can override
	 * via task.metadata.quota.tokens.
	 */
	defaultTaskTokenQuota?: number;
}

export function tasksPlugin(_options: TasksPluginOptions = {}): PluginDescriptor {
	return {
		id: "tasks",
		version: "0.0.1",
		format: "standard",
		entrypoint: "@emdash-cms/plugin-tasks/sandbox",
		options: {},
		capabilities: ["read:content", "write:content"],
		storage: {
			tasks: {
				indexes: [
					"status",
					"assignee",
					"parent_id",
					"target_collection",
					"created_by",
					"created_at",
					["status", "assignee"],
					["status", "created_at"],
					["assignee", "status"],
				],
			},
			// Per-day per-assignee cost counter — keys "<YYYY-MM-DD>:<actor>"
			// so we can decide quota fast without scanning the activity log.
			daily_cost: {
				indexes: ["actor", "day"],
			},
		},
		adminPages: [{ path: "/tasks", label: "Tasks", icon: "checklist" }],
		adminWidgets: [{ id: "tasks-active", title: "Active tasks", size: "half" }],
	};
}
