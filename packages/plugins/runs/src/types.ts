/**
 * Run types.
 *
 * A `Run` is one execution of an agent against a goal. It persists
 * across iterations of the chat loop so an operator can pause, cancel,
 * and resume; so cost can be enforced per-run; and so a future
 * supervision UI can stream events without a long-lived connection.
 *
 * `RunEvent` is an append-only log of everything that happened during
 * the run — every LLM call, every tool invocation, every limit hit.
 * Ordinals are monotonic per run; an operator can backfill missed
 * events by querying since `ordinal > N`.
 */

import type { ChatMessage, ChatCompletionInput, ToolSpec } from "@emdash-cms/plugin-llm-router";

export type RunStatus =
	| "queued"
	| "running"
	| "awaiting_approval"
	| "paused"
	| "completed"
	| "failed"
	| "cancelled";

export interface RunCost {
	tokens_in: number;
	tokens_out: number;
	usd: number;
	calls: number;
}

export interface RunLimits {
	max_iterations: number;
	max_tokens?: number;
	max_usd?: number;
	max_wallclock_ms?: number;
}

export interface RunPause {
	kind: string;
	payload: Record<string, unknown>;
	created_at: string;
}

export interface RunError {
	message: string;
	iteration: number;
}

export interface Run {
	id: string;
	agent_id: string;
	task_id?: string;
	parent_run_id?: string;
	status: RunStatus;
	/**
	 * Full message history; grows with each iteration. The driver receives
	 * this on every `chatCompletion` call. Source of truth for resume.
	 */
	message_history: ChatMessage[];
	/** Tools the model is allowed to call this run. Captured at start. */
	tools?: ToolSpec[];
	/** Iteration counter; incremented at the start of each tick. */
	iteration: number;
	limits: RunLimits;
	cost: RunCost;
	cancel_requested: boolean;
	paused_for_human?: RunPause;
	approval_token?: string;
	model: string;
	driver_id: string;
	completion_input: ChatCompletionInput;
	started_at: string;
	updated_at: string;
	completed_at?: string;
	error?: RunError;
}

export type RunEventKind =
	| "run-started"
	| "iteration-started"
	| "llm-call"
	| "tool-call"
	| "human-pause"
	| "human-resume"
	| "limit-hit"
	| "error"
	| "run-completed"
	| "run-failed"
	| "run-cancelled";

export interface RunEvent {
	id: string;
	run_id: string;
	ordinal: number;
	kind: RunEventKind;
	payload: Record<string, unknown>;
	created_at: string;
}

/** Input to `runs.start`. */
export interface StartRunInput {
	agent_id: string;
	task_id?: string;
	parent_run_id?: string;
	prompt?: string;
	messages?: ChatMessage[];
	tools?: ToolSpec[];
	model?: string;
	driver_id?: string;
	max_iterations?: number;
	max_tokens?: number;
	max_usd?: number;
	max_wallclock_ms?: number;
}
