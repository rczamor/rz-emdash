/**
 * Task state machine.
 *
 *   backlog ──────► in_progress
 *   in_progress ──► pending_review | cancelled
 *   pending_review ► approved | rejected | in_progress
 *   rejected ─────► in_progress | cancelled
 *   approved ─────► published | rejected | in_progress (revision)
 *   published ────► in_progress (revision) | (terminal)
 *   cancelled ────► (terminal)
 *
 * Transitions outside this map throw. Override discipline by passing
 * `force: true` to transitionTask if you really must.
 */

import type { TaskStatus } from "./types.js";

const ALLOWED: Record<TaskStatus, TaskStatus[]> = {
	backlog: ["in_progress", "cancelled"],
	in_progress: ["pending_review", "cancelled"],
	pending_review: ["approved", "rejected", "in_progress"],
	rejected: ["in_progress", "cancelled"],
	approved: ["published", "rejected", "in_progress"],
	published: ["in_progress"],
	cancelled: [],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
	return ALLOWED[from]?.includes(to) ?? false;
}

export function allTransitions(from: TaskStatus): TaskStatus[] {
	return ALLOWED[from] ?? [];
}

export const STATUS_BADGE_COLORS: Record<TaskStatus, string> = {
	backlog: "default",
	in_progress: "info",
	pending_review: "warning",
	approved: "success",
	rejected: "danger",
	published: "success",
	cancelled: "default",
};

export const TERMINAL: TaskStatus[] = ["published", "cancelled"];

export function isTerminal(status: TaskStatus): boolean {
	return TERMINAL.includes(status);
}
