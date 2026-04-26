/**
 * Task types — the work-unit primitive for agentic content management.
 */

export type TaskStatus =
	| "backlog"
	| "in_progress"
	| "pending_review"
	| "approved"
	| "rejected"
	| "published"
	| "cancelled";

/**
 * Polymorphic assignee. Always namespaced. Examples:
 *   "human:rczamor"            — emdash user
 *   "agent:writer-bot"         — registered agent (see Agents plugin)
 *   "system"                   — automation engine, not human or agent
 */
export type Actor = string;

export type ActivityType =
	| "created"
	| "updated"
	| "transitioned"
	| "assigned"
	| "commented"
	| "llm-call"
	| "tool-call"
	| "cost"
	| "reviewed"
	| "error";

export interface ActivityEntry {
	id: string;
	at: string;
	actor: Actor;
	type: ActivityType;
	data?: Record<string, unknown>;
}

export interface CostLedger {
	tokensIn: number;
	tokensOut: number;
	usd?: number;
	calls: number;
}

export interface Task {
	id: string;
	parent_id?: string;
	goal: string;
	description?: string;

	// Target entity (optional — task may not have a target yet, or may
	// produce a brand-new content item on completion)
	target_collection?: string;
	target_id?: string;

	assignee?: Actor;
	created_by: Actor;

	status: TaskStatus;

	deadline?: string;
	publish_at?: string;

	depends_on?: string[];

	output?: Record<string, unknown>;

	cost: CostLedger;

	activity: ActivityEntry[];

	created_at: string;
	updated_at: string;
}

export interface CreateTaskInput {
	id?: string;
	parent_id?: string;
	goal: string;
	description?: string;
	target_collection?: string;
	target_id?: string;
	assignee?: Actor;
	created_by?: Actor;
	deadline?: string;
	publish_at?: string;
	depends_on?: string[];
	output?: Record<string, unknown>;
	status?: TaskStatus;
}

export interface UpdateTaskInput {
	id: string;
	goal?: string;
	description?: string;
	target_collection?: string;
	target_id?: string;
	deadline?: string;
	publish_at?: string;
	depends_on?: string[];
	output?: Record<string, unknown>;
	actor?: Actor;
}

export interface TransitionTaskInput {
	id: string;
	to: TaskStatus;
	actor?: Actor;
	comment?: string;
}

export interface AssignTaskInput {
	id: string;
	assignee: Actor;
	actor?: Actor;
}

export interface CommentTaskInput {
	id: string;
	text: string;
	actor: Actor;
}

export interface RecordCostInput {
	id: string;
	model: string;
	tokensIn: number;
	tokensOut: number;
	usd?: number;
	source?: string;
	actor?: Actor;
}
