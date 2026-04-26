/**
 * Block Kit views for the Agents plugin.
 */

import type { PluginContext } from "emdash";

import type { Agent } from "./types.js";

interface AdminInteraction {
	type?: string;
	page?: string;
	widget?: string;
	action_id?: string;
	value?: string;
	values?: Record<string, unknown>;
}

async function loadAgent(id: string, ctx: PluginContext): Promise<Agent | null> {
	const v = await ctx.storage.agents.get(id);
	return (v as Agent | null) ?? null;
}

async function listAgents(ctx: PluginContext): Promise<Agent[]> {
	const result = await ctx.storage.agents.query({
		orderBy: { created_at: "desc" },
		limit: 200,
	});
	return result.items.map((i) => i.data as Agent);
}

function viewListPage(agents: Agent[]) {
	const blocks: unknown[] = [
		{ type: "header", text: "Agents" },
		{
			type: "context",
			elements: [
				{
					type: "text",
					text: "Agents are runtime identities the Tasks plugin can assign to. Each has identity files, a skills allowlist, a tools allowlist, model preferences, and per-agent quotas.",
				},
			],
		},
		{
			type: "actions",
			elements: [
				{ type: "button", text: "+ New agent", action_id: "new_agent", style: "primary" },
			],
		},
	];

	if (agents.length === 0) {
		blocks.push({
			type: "banner",
			variant: "default",
			title: "No agents yet",
			description: "Create one via POST /_emdash/api/plugins/agents/agents.create or the New agent button.",
		});
	} else {
		blocks.push({
			type: "table",
			blockId: "agents-list",
			columns: [
				{ key: "id", label: "ID", format: "text" },
				{ key: "name", label: "Name", format: "text" },
				{ key: "role", label: "Role", format: "text" },
				{ key: "model", label: "Model", format: "text" },
				{ key: "skills", label: "Skills", format: "text" },
				{ key: "tools", label: "Tools", format: "text" },
				{ key: "active", label: "Active", format: "badge" },
			],
			rows: agents.map((a) => ({
				id: a.id,
				name: a.name,
				role: a.role,
				model: a.model.primary,
				skills: String(a.skills.length),
				tools: String(a.tools.length),
				active: a.active ? "Active" : "Inactive",
			})),
		});

		for (const a of agents) {
			blocks.push({
				type: "actions",
				elements: [
					{ type: "context", elements: [{ type: "text", text: a.id }] },
					{ type: "button", text: "Edit", action_id: "view_agent", value: a.id },
					{
						type: "button",
						text: a.active ? "Deactivate" : "Activate",
						action_id: "toggle_agent",
						value: a.id,
						style: a.active ? "secondary" : "primary",
					},
					{
						type: "button",
						text: "Delete",
						action_id: "delete_agent",
						value: a.id,
						style: "danger",
						confirm: {
							title: "Delete agent?",
							text: `${a.id} will be removed. Memory rows persist until you delete them separately.`,
							confirm: "Delete",
							deny: "Cancel",
						},
					},
				],
			});
		}
	}

	return { blocks };
}

function viewNewAgent() {
	return {
		blocks: [
			{ type: "header", text: "New agent" },
			{
				type: "actions",
				elements: [{ type: "button", text: "← Back", action_id: "back_to_list" }],
			},
			{
				type: "form",
				block_id: "create_agent",
				fields: [
					{ type: "text_input", action_id: "id", label: "ID (slug, lowercase + hyphens)" },
					{ type: "text_input", action_id: "name", label: "Display name" },
					{ type: "text_input", action_id: "role", label: "Role (e.g. Writer, Editor)" },
					{
						type: "text_input",
						action_id: "model_primary",
						label: "Primary model",
						initial_value: "anthropic/claude-haiku-4-5",
					},
					{
						type: "text_input",
						action_id: "identity",
						label: "Identity (markdown — IDENTITY.md content)",
						multiline: true,
					},
					{
						type: "text_input",
						action_id: "soul",
						label: "Soul (markdown — voice, values; optional)",
						multiline: true,
					},
					{
						type: "text_input",
						action_id: "skills",
						label: "Skill slugs (comma-separated, optional)",
					},
					{
						type: "text_input",
						action_id: "tools",
						label: "Tool names (comma-separated, optional)",
					},
				],
				submit: { label: "Create", action_id: "create_agent" },
			},
		],
	};
}

function viewEditAgent(agent: Agent) {
	return {
		blocks: [
			{ type: "header", text: `Agent: ${agent.name}` },
			{
				type: "context",
				elements: [{ type: "text", text: `id: ${agent.id} · role: ${agent.role}` }],
			},
			{
				type: "actions",
				elements: [{ type: "button", text: "← Back", action_id: "back_to_list" }],
			},
			{
				type: "form",
				block_id: `edit_${agent.id}`,
				fields: [
					{ type: "text_input", action_id: "name", label: "Display name", initial_value: agent.name },
					{ type: "text_input", action_id: "role", label: "Role", initial_value: agent.role },
					{
						type: "text_input",
						action_id: "model_primary",
						label: "Primary model",
						initial_value: agent.model.primary,
					},
					{
						type: "text_input",
						action_id: "identity",
						label: "Identity",
						multiline: true,
						initial_value: agent.identity,
					},
					{
						type: "text_input",
						action_id: "soul",
						label: "Soul",
						multiline: true,
						initial_value: agent.soul ?? "",
					},
					{
						type: "text_input",
						action_id: "skills",
						label: "Skill slugs (comma-separated)",
						initial_value: agent.skills.join(","),
					},
					{
						type: "text_input",
						action_id: "tools",
						label: "Tool names (comma-separated)",
						initial_value: agent.tools.join(","),
					},
					{
						type: "number_input",
						action_id: "quota_daily",
						label: "Daily token quota (0 = unlimited)",
						initial_value: agent.quotas?.dailyTokens ?? 0,
					},
					{
						type: "number_input",
						action_id: "quota_task",
						label: "Per-task token quota (0 = unlimited)",
						initial_value: agent.quotas?.taskTokens ?? 0,
					},
				],
				submit: { label: "Save", action_id: `save_agent|${agent.id}` },
			},
		],
	};
}

async function widgetActiveAgents(ctx: PluginContext) {
	const agents = await listAgents(ctx);
	const active = agents.filter((a) => a.active);
	return {
		blocks: [
			{ type: "header", text: "Active agents" },
			{
				type: "stats",
				stats: [
					{ label: "Active", value: String(active.length) },
					{ label: "Total", value: String(agents.length) },
				],
			},
			active.length > 0
				? {
						type: "table",
						blockId: "agents-active-widget",
						columns: [
							{ key: "id", label: "ID", format: "text" },
							{ key: "role", label: "Role", format: "text" },
							{ key: "model", label: "Model", format: "text" },
						],
						rows: active.slice(0, 5).map((a) => ({
							id: a.id,
							role: a.role,
							model: a.model.primary,
						})),
					}
				: null,
		].filter(Boolean),
	};
}

interface AdminEffects {
	create?: { values: Record<string, unknown> };
	save?: { id: string; values: Record<string, unknown> };
	toggle?: { id: string };
	delete?: { id: string };
}

export async function routeAdminInteraction(
	interaction: AdminInteraction,
	ctx: PluginContext,
): Promise<
	| { kind: "view"; blocks: unknown[] }
	| { kind: "effect"; effect: AdminEffects; refresh: { agentId?: string } }
> {
	if (interaction.type === "page_load" && interaction.page === "/agents") {
		return { kind: "view", blocks: viewListPage(await listAgents(ctx)).blocks };
	}
	if (interaction.type === "widget_load" && interaction.widget === "agents-active") {
		const w = await widgetActiveAgents(ctx);
		return { kind: "view", blocks: w.blocks as unknown[] };
	}

	if (interaction.type === "block_action") {
		const aid = interaction.action_id;
		if (aid === "back_to_list") {
			return { kind: "view", blocks: viewListPage(await listAgents(ctx)).blocks };
		}
		if (aid === "new_agent") {
			return { kind: "view", blocks: viewNewAgent().blocks };
		}
		if (aid === "view_agent" && interaction.value) {
			const agent = await loadAgent(interaction.value, ctx);
			if (agent) return { kind: "view", blocks: viewEditAgent(agent).blocks };
		}
		if (aid === "toggle_agent" && interaction.value) {
			return {
				kind: "effect",
				effect: { toggle: { id: interaction.value } },
				refresh: {},
			};
		}
		if (aid === "delete_agent" && interaction.value) {
			return {
				kind: "effect",
				effect: { delete: { id: interaction.value } },
				refresh: {},
			};
		}
	}

	if (interaction.type === "form_submit") {
		const aid = interaction.action_id ?? "";
		if (aid === "create_agent") {
			return {
				kind: "effect",
				effect: { create: { values: interaction.values ?? {} } },
				refresh: {},
			};
		}
		const [verb, agentId] = aid.split("|");
		if (verb === "save_agent" && agentId) {
			return {
				kind: "effect",
				effect: { save: { id: agentId, values: interaction.values ?? {} } },
				refresh: { agentId },
			};
		}
	}

	return { kind: "view", blocks: viewListPage(await listAgents(ctx)).blocks };
}

export async function renderRefreshedView(
	agentId: string | undefined,
	ctx: PluginContext,
): Promise<unknown[]> {
	if (!agentId) return viewListPage(await listAgents(ctx)).blocks;
	const agent = await loadAgent(agentId, ctx);
	if (!agent) return viewListPage(await listAgents(ctx)).blocks;
	return viewEditAgent(agent).blocks;
}
