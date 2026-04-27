/**
 * Block Kit admin views for the Tasks plugin.
 *
 * Two views:
 *   - List view (filtered by status / assignee)
 *   - Detail view for a single task with transitions, comments,
 *     activity, cost summary
 *
 * Mutating buttons all carry a `value` payload of the task id (and
 * sometimes the target status). The dispatcher in sandbox-entry calls
 * the same engine the public routes use — buttons and routes share
 * one mutation path.
 */

import type { PluginContext, WhereClause, WhereValue } from "emdash";

import { allTransitions, STATUS_BADGE_COLORS } from "./states.js";
import type { Task, TaskStatus } from "./types.js";

const STATUS_ORDER: TaskStatus[] = [
	"backlog",
	"in_progress",
	"pending_review",
	"approved",
	"rejected",
	"published",
	"cancelled",
];

function scalarString(value: unknown, fallback = ""): string {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return fallback;
}

interface AdminInteraction {
	type?: string;
	page?: string;
	widget?: string;
	action_id?: string;
	value?: string;
	values?: Record<string, unknown>;
}

async function loadTask(id: string, ctx: PluginContext): Promise<Task | null> {
	const v = await ctx.storage.tasks!.get(id);
	return (v as Task | null) ?? null;
}

async function listTasks(filter: WhereClause | undefined, ctx: PluginContext) {
	const result = await ctx.storage.tasks!.query({
		where: filter,
		orderBy: { created_at: "desc" },
		limit: 200,
	});
	return result.items.map((i) => i.data as Task);
}

function summarizeCost(task: Task): string {
	const c = task.cost;
	const parts = [`${c.calls} call${c.calls === 1 ? "" : "s"}`];
	if (c.tokensIn || c.tokensOut) {
		parts.push(`${c.tokensIn + c.tokensOut} tokens`);
	}
	if (c.usd) {
		parts.push(`$${c.usd.toFixed(4)}`);
	}
	return parts.join(" · ");
}

function viewListPage(tasks: Task[], filterStatus?: string, filterAssignee?: string) {
	const blocks: unknown[] = [
		{ type: "header", text: "Tasks" },
		{
			type: "context",
			elements: [
				{
					type: "text",
					text: "Tasks are the unit of agentic work. Create them via the API; transition them here or via routines.",
				},
			],
		},
		{
			type: "form",
			block_id: "tasks-filter",
			fields: [
				{
					type: "select",
					action_id: "filterStatus",
					label: "Status",
					initial_value: filterStatus ?? "",
					options: [
						{ value: "", label: "All" },
						...STATUS_ORDER.map((s) => ({ value: s, label: s })),
					],
				},
				{
					type: "text_input",
					action_id: "filterAssignee",
					label: "Assignee (e.g. agent:writer-bot)",
					initial_value: filterAssignee ?? "",
				},
			],
			submit: { label: "Filter", action_id: "tasks_filter" },
		},
	];

	if (tasks.length === 0) {
		blocks.push({
			type: "banner",
			variant: "default",
			title: "No tasks match",
			description: "Create one via POST /_emdash/api/plugins/tasks/tasks.create",
		});
	} else {
		blocks.push({
			type: "table",
			blockId: "tasks-list",
			columns: [
				{ key: "id", label: "ID", format: "text" },
				{ key: "goal", label: "Goal", format: "text" },
				{ key: "status", label: "Status", format: "badge" },
				{ key: "assignee", label: "Assignee", format: "text" },
				{ key: "deadline", label: "Deadline", format: "relative_time" },
				{ key: "cost", label: "Cost", format: "text" },
			],
			rows: tasks.map((t) => ({
				id: t.id.slice(0, 12),
				goal: t.goal.length > 60 ? t.goal.slice(0, 57) + "…" : t.goal,
				status: t.status,
				assignee: t.assignee ?? "",
				deadline: t.deadline ?? "",
				cost: summarizeCost(t),
			})),
		});

		for (const t of tasks) {
			blocks.push({
				type: "actions",
				elements: [
					{ type: "context", elements: [{ type: "text", text: t.id.slice(0, 12) }] },
					{
						type: "button",
						text: "Open",
						action_id: "view_task",
						value: t.id,
					},
				],
			});
		}
	}

	return { blocks };
}

function viewDetail(task: Task) {
	const transitions = allTransitions(task.status);
	const transitionButtons = transitions.map((to) => ({
		type: "button",
		text: `→ ${to}`,
		action_id: "transition_task",
		value: `${task.id}|${to}`,
		style:
			to === "approved" || to === "published"
				? "primary"
				: to === "rejected" || to === "cancelled"
					? "danger"
					: "secondary",
	}));

	const blocks: unknown[] = [
		{ type: "header", text: task.goal },
		{
			type: "context",
			elements: [
				{ type: "text", text: `id: ${task.id}` },
				{ type: "text", text: `status: ${task.status}` },
				{ type: "text", text: `assignee: ${task.assignee ?? "—"}` },
				{ type: "text", text: `created by: ${task.created_by}` },
			],
		},
		{
			type: "actions",
			elements: [{ type: "button", text: "← Back to list", action_id: "back_to_list" }],
		},
	];

	if (task.description) {
		blocks.push({ type: "header", text: "Description" });
		blocks.push({ type: "section", text: task.description });
	}

	blocks.push({ type: "header", text: "State" });
	blocks.push({
		type: "fields",
		fields: [
			{ label: "Status", value: task.status },
			{ label: "Deadline", value: task.deadline ?? "—" },
			{ label: "Publish at", value: task.publish_at ?? "—" },
			{
				label: "Target",
				value: task.target_collection
					? `${task.target_collection}${task.target_id ? `/${task.target_id}` : ""}`
					: "—",
			},
			{ label: "Cost (calls)", value: String(task.cost.calls) },
			{ label: "Cost (tokens)", value: String(task.cost.tokensIn + task.cost.tokensOut) },
			{ label: "Cost ($USD)", value: task.cost.usd ? `$${task.cost.usd.toFixed(4)}` : "—" },
		],
	});

	if (transitions.length > 0) {
		blocks.push({ type: "header", text: "Transitions" });
		blocks.push({ type: "actions", elements: transitionButtons });
	}

	blocks.push({ type: "header", text: "Assign" });
	blocks.push({
		type: "form",
		block_id: `assign_${task.id}`,
		fields: [
			{
				type: "text_input",
				action_id: "assignee",
				label: "Assignee (human:<id> or agent:<slug>)",
				initial_value: task.assignee ?? "",
			},
		],
		submit: { label: "Assign", action_id: `assign_task|${task.id}` },
	});

	blocks.push({ type: "header", text: "Comment" });
	blocks.push({
		type: "form",
		block_id: `comment_${task.id}`,
		fields: [{ type: "text_input", action_id: "text", label: "Comment", multiline: true }],
		submit: { label: "Post comment", action_id: `comment_task|${task.id}` },
	});

	if (task.output && Object.keys(task.output).length > 0) {
		blocks.push({ type: "header", text: "Output" });
		blocks.push({
			type: "code",
			code: JSON.stringify(task.output, null, 2),
			language: "jsonc",
		});
	}

	if (task.activity.length > 0) {
		blocks.push({ type: "header", text: "Activity" });
		blocks.push({
			type: "table",
			blockId: `activity_${task.id}`,
			columns: [
				{ key: "at", label: "When", format: "relative_time" },
				{ key: "actor", label: "Actor", format: "text" },
				{ key: "type", label: "Type", format: "text" },
				{ key: "summary", label: "Detail", format: "text" },
			],
			rows: task.activity.map((a) => ({
				at: a.at,
				actor: a.actor,
				type: a.type,
				summary: summarizeActivity(a.type, a.data),
			})),
		});
	}

	return { blocks };
}

function summarizeActivity(type: string, data?: Record<string, unknown>): string {
	if (!data) return "";
	if (type === "transitioned") return `${scalarString(data.from)} → ${scalarString(data.to)}`;
	if (type === "assigned") return scalarString(data.assignee);
	if (type === "commented") {
		const t = scalarString(data.text);
		return t.length > 80 ? t.slice(0, 77) + "…" : t;
	}
	if (type === "llm-call" || type === "cost") {
		return `${scalarString(data.model, "?")} · ${Number(data.tokensIn ?? 0)}+${Number(data.tokensOut ?? 0)}`;
	}
	return JSON.stringify(data).slice(0, 80);
}

async function widgetActiveTasks(ctx: PluginContext) {
	const tasks = await listTasks({ status: "in_progress" }, ctx);
	const reviewing = await listTasks({ status: "pending_review" }, ctx);
	return {
		blocks: [
			{ type: "header", text: "Active tasks" },
			{
				type: "stats",
				stats: [
					{ label: "In progress", value: String(tasks.length) },
					{ label: "Pending review", value: String(reviewing.length) },
				],
			},
		],
	};
}

interface AdminEffects {
	transition?: { id: string; to: TaskStatus };
	assign?: { id: string; assignee: string };
	comment?: { id: string; text: string };
}

/**
 * Dispatch an admin interaction. Returns either { blocks } directly
 * for view-only navigations, or { effects, view } when a mutation
 * should occur. The caller in sandbox-entry runs the mutation through
 * the same engine the routes use, then renders the resulting view.
 */
export async function routeAdminInteraction(
	interaction: AdminInteraction,
	ctx: PluginContext,
): Promise<
	| { kind: "view"; blocks: unknown[]; toast?: unknown }
	| { kind: "effect"; effect: AdminEffects; refresh: { taskId?: string } }
> {
	if (interaction.type === "page_load" && interaction.page === "/tasks") {
		const all = await listTasks(undefined, ctx);
		const v = viewListPage(all);
		return { kind: "view", blocks: v.blocks };
	}
	if (interaction.type === "widget_load" && interaction.widget === "tasks-active") {
		const v = await widgetActiveTasks(ctx);
		return { kind: "view", blocks: v.blocks };
	}

	if (interaction.type === "block_action") {
		const aid = interaction.action_id;
		if (aid === "back_to_list") {
			const all = await listTasks(undefined, ctx);
			return { kind: "view", blocks: viewListPage(all).blocks };
		}
		if (aid === "view_task" && interaction.value) {
			const task = await loadTask(interaction.value, ctx);
			if (task) return { kind: "view", blocks: viewDetail(task).blocks };
		}
		if (aid === "transition_task" && interaction.value) {
			const [id, to] = interaction.value.split("|");
			if (id && to) {
				return {
					kind: "effect",
					effect: { transition: { id, to: to as TaskStatus } },
					refresh: { taskId: id },
				};
			}
		}
	}

	if (interaction.type === "form_submit") {
		const aid = interaction.action_id ?? "";
		if (aid === "tasks_filter") {
			const v = interaction.values ?? {};
			const filterStatus = v.filterStatus ? scalarString(v.filterStatus) : undefined;
			const filterAssignee = v.filterAssignee ? scalarString(v.filterAssignee) : undefined;
			const filter: Record<string, WhereValue> = {};
			if (filterStatus) filter.status = filterStatus;
			if (filterAssignee) filter.assignee = filterAssignee;
			const tasks = await listTasks(Object.keys(filter).length > 0 ? filter : undefined, ctx);
			return { kind: "view", blocks: viewListPage(tasks, filterStatus, filterAssignee).blocks };
		}
		const [verb, taskId] = aid.split("|");
		if (verb === "assign_task" && taskId) {
			const assignee = scalarString(interaction.values?.assignee).trim();
			if (assignee)
				return {
					kind: "effect",
					effect: { assign: { id: taskId, assignee } },
					refresh: { taskId },
				};
		}
		if (verb === "comment_task" && taskId) {
			const text = scalarString(interaction.values?.text).trim();
			if (text)
				return { kind: "effect", effect: { comment: { id: taskId, text } }, refresh: { taskId } };
		}
	}

	const all = await listTasks(undefined, ctx);
	return { kind: "view", blocks: viewListPage(all).blocks };
}

export async function renderRefreshedView(
	taskId: string | undefined,
	ctx: PluginContext,
): Promise<unknown[]> {
	if (!taskId) {
		const all = await listTasks(undefined, ctx);
		return viewListPage(all).blocks;
	}
	const task = await loadTask(taskId, ctx);
	if (!task) {
		const all = await listTasks(undefined, ctx);
		return viewListPage(all).blocks;
	}
	return viewDetail(task).blocks;
}

export const _internalForTests = { viewListPage, viewDetail };
// Prevent unused-export linting
void STATUS_BADGE_COLORS;
