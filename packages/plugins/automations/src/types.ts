/**
 * Routine types for the Automations plugin.
 *
 * A routine is { trigger, optional filter, one-or-more actions }. Stored
 * as JSON in plugin storage. Loaded into the engine on plugin:activate
 * and on every routines.upsert.
 */

export type EventTriggerName =
	| "content:beforeSave"
	| "content:afterSave"
	| "content:beforeDelete"
	| "content:afterDelete"
	| "content:afterPublish"
	| "content:afterUnpublish"
	| "media:beforeUpload"
	| "media:afterUpload"
	| "comment:beforeCreate"
	| "comment:afterCreate"
	| "comment:afterModerate"
	| "email:afterSend"
	// Task lifecycle (emitted by @emdash-cms/plugin-tasks)
	| "task:created"
	| "task:transitioned"
	| "task:assigned"
	| "task:commented"
	| "task:cost-recorded"
	| "task:reviewed"
	| "task:completed"
	// LLM gateway lifecycle (provider-agnostic — OpenRouter, LiteLLM, etc.
	// emit these so observability/eval plugins like Langfuse can subscribe)
	| "llm:call-started"
	| "llm:call-finished"
	| "llm:call-failed";

export interface EventTrigger {
	on: EventTriggerName;
}

export interface CronTrigger {
	on: "cron";
	/** Cron expression in standard 5-field syntax: minute hour day month weekday */
	schedule: string;
}

export type Trigger = EventTrigger | CronTrigger;

// ── Filter DSL ──────────────────────────────────────────────────────────────
// Structured rather than expression-based to keep it diff-able and
// machine-authorable. Compose with `all` / `any` / `not`.

export interface FilterEq {
	eq: { path: string; value: unknown };
}
export interface FilterNe {
	ne: { path: string; value: unknown };
}
export interface FilterIn {
	in: { path: string; values: unknown[] };
}
export interface FilterNotIn {
	notIn: { path: string; values: unknown[] };
}
export interface FilterContains {
	contains: { path: string; value: string };
}
export interface FilterMatches {
	matches: { path: string; pattern: string; flags?: string };
}
export interface FilterGt {
	gt: { path: string; value: number };
}
export interface FilterGte {
	gte: { path: string; value: number };
}
export interface FilterLt {
	lt: { path: string; value: number };
}
export interface FilterLte {
	lte: { path: string; value: number };
}
export interface FilterExists {
	exists: { path: string };
}
export interface FilterAll {
	all: Filter[];
}
export interface FilterAny {
	any: Filter[];
}
export interface FilterNot {
	not: Filter;
}

export type Filter =
	| FilterEq
	| FilterNe
	| FilterIn
	| FilterNotIn
	| FilterContains
	| FilterMatches
	| FilterGt
	| FilterGte
	| FilterLt
	| FilterLte
	| FilterExists
	| FilterAll
	| FilterAny
	| FilterNot;

// ── Action types ────────────────────────────────────────────────────────────

export interface EmailAction {
	type: "email";
	to: string;
	subject: string;
	body: string;
}

export interface WebhookAction {
	type: "webhook";
	url: string;
	method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
	headers?: Record<string, string>;
	body?: string;
}

export interface LogAction {
	type: "log";
	level?: "debug" | "info" | "warn" | "error";
	message: string;
	data?: Record<string, unknown>;
}

export interface KvSetAction {
	type: "kv:set";
	key: string;
	value: unknown;
}

export interface CustomAction {
	type: string;
}

export type BuiltInAction = EmailAction | WebhookAction | LogAction | KvSetAction;
export type Action = BuiltInAction | CustomAction;

// ── Routine ────────────────────────────────────────────────────────────────

export interface Routine {
	id: string;
	name: string;
	description?: string;
	enabled: boolean;
	trigger: Trigger;
	filter?: Filter;
	actions: Action[];
	createdAt: string;
	updatedAt: string;
	/** Run statistics — updated by the engine */
	stats?: {
		lastRunAt?: string;
		lastError?: string;
		runCount?: number;
	};
}

export interface RoutineEvent {
	/** The hook name or "cron" */
	source: string;
	/** Whatever the hook payload was, plus our augmentations */
	event: Record<string, unknown>;
	/** Available context for token resolution */
	context: Record<string, unknown>;
}
