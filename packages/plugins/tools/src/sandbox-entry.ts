/**
 * Tools — runtime entrypoint.
 *
 * Routes:
 *   GET   tools.list                                    list registered tools
 *   GET   tools.get?name=                               full tool spec
 *   GET   tools.openaiSpec?agent_id=&allow=             OpenAI-compatible spec, optionally filtered by agent allowlist
 *   POST  tools.invoke                                  { name, arguments, taskId? } → execution + activity log
 *   GET   invocations.list?tool=&task_id=&limit=        recent invocations (audit)
 *   POST  admin                                         Block Kit
 */

import { definePlugin } from "emdash";
import type { PluginContext, WhereValue } from "emdash";

import { registerBuiltInTools } from "./built-ins.js";
import { getTool, listTools } from "./registry.js";
import type { InvokeInput, OpenAITool } from "./types.js";

registerBuiltInTools();

const TRAILING_SLASH_RE = /\/$/;

interface RouteCtx {
	input: unknown;
	request: Request;
}

const NOW = () => new Date().toISOString();

function getQueryParam(routeCtx: RouteCtx, key: string): string | undefined {
	return new URL(routeCtx.request.url).searchParams.get(key) ?? undefined;
}

function newInvocationId(): string {
	return `inv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function toolsToOpenAISpec(allowList?: Set<string>): OpenAITool[] {
	return listTools()
		.filter((t) => !allowList || allowList.has(t.name))
		.map((t) => ({
			type: "function" as const,
			function: {
				name: t.name,
				description: t.description,
				parameters: t.parameters,
			},
		}));
}

async function getAllowListForAgent(
	agentId: string,
	ctx: PluginContext,
): Promise<Set<string> | null> {
	if (!ctx.http) return null;
	const baseUrl = (
		(ctx.site as { url?: string } | undefined)?.url ?? "http://localhost:4321"
	).replace(TRAILING_SLASH_RE, "");
	try {
		const res = await ctx.http.fetch(
			`${baseUrl}/_emdash/api/plugins/agents/agents.get?id=${encodeURIComponent(agentId)}`,
		);
		if (!res.ok) return null;
		const json = (await res.json()) as {
			data?: { ok?: boolean; agent?: { tools?: string[] } };
		};
		if (json.data?.ok === false) return null;
		const tools = json.data?.agent?.tools;
		return new Set(tools ?? []);
	} catch {
		return null;
	}
}

interface InvocationRecord {
	id: string;
	tool: string;
	task_id?: string;
	args: Record<string, unknown>;
	output?: unknown;
	error?: string;
	durationMs: number;
	createdAt: string;
}

async function recordInvocation(record: InvocationRecord, ctx: PluginContext): Promise<void> {
	try {
		await ctx.storage.invocations!.put(record.id, record);
	} catch (err) {
		ctx.log.warn("Tools: failed to record invocation", {
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

async function appendTaskActivity(
	taskId: string,
	tool: string,
	output: unknown,
	error: string | undefined,
	durationMs: number,
	ctx: PluginContext,
): Promise<void> {
	if (!ctx.http) return;
	const baseUrl = (
		(ctx.site as { url?: string } | undefined)?.url ?? "http://localhost:4321"
	).replace(TRAILING_SLASH_RE, "");
	try {
		// Tasks plugin doesn't have an explicit "activity append" route —
		// activity is appended by mutations. We log via a comment instead,
		// which appends a "commented" activity entry. A future Tasks
		// plugin update could add a generic activity.append route.
		await ctx.http.fetch(`${baseUrl}/_emdash/api/plugins/tasks/tasks.comment`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				id: taskId,
				actor: "system",
				text: `[tool-call] ${tool}${error ? ` failed: ${error}` : " ok"} (${durationMs}ms)`,
			}),
		});
	} catch (err) {
		ctx.log.warn("Tools: failed to attach tool-call to task", {
			taskId,
			tool,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

// ── Plugin definition ───────────────────────────────────────────────────────

export default definePlugin({
	hooks: {
		"plugin:install": {
			handler: async (_event: unknown, ctx: PluginContext) => {
				ctx.log.info(`Tools plugin installed (${listTools().length} built-in tools registered)`);
			},
		},
	},

	routes: {
		"tools.list": {
			handler: async () => {
				const tools = listTools().map((t) => ({
					name: t.name,
					description: t.description,
					capabilities: t.capabilities ?? [],
				}));
				return { tools };
			},
		},

		"tools.get": {
			handler: async (routeCtx: RouteCtx) => {
				const name = getQueryParam(routeCtx, "name");
				if (!name) return { ok: false, error: "name required" };
				const tool = getTool(name);
				if (!tool) return { ok: false, error: "Not found" };
				return {
					ok: true,
					tool: {
						name: tool.name,
						description: tool.description,
						parameters: tool.parameters,
						capabilities: tool.capabilities ?? [],
					},
				};
			},
		},

		"tools.openaiSpec": {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const agentId = getQueryParam(routeCtx, "agent_id");
				const allowParam = getQueryParam(routeCtx, "allow");
				let allowList: Set<string> | undefined;
				if (allowParam) {
					allowList = new Set(
						allowParam
							.split(",")
							.map((s) => s.trim())
							.filter(Boolean),
					);
				} else if (agentId) {
					allowList = (await getAllowListForAgent(agentId, ctx)) ?? new Set();
				}
				return { tools: toolsToOpenAISpec(allowList) };
			},
		},

		"tools.invoke": {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const body = routeCtx.input as InvokeInput | null;
				if (!body || !body.name) return { ok: false, error: "name required" };
				const tool = getTool(body.name);
				if (!tool) return { ok: false, error: `Unknown tool: ${body.name}` };
				if (body.agentId) {
					const allowList = await getAllowListForAgent(body.agentId, ctx);
					if (!allowList) {
						return { ok: false, error: "Unable to verify agent tool allowlist" };
					}
					if (!allowList.has(body.name)) {
						return { ok: false, error: `Tool not allowed for agent: ${body.name}` };
					}
				}

				const start = Date.now();
				const id = newInvocationId();
				let output: unknown;
				let error: string | undefined;
				try {
					output = await tool.handler(body.arguments ?? {}, ctx);
				} catch (err) {
					error = err instanceof Error ? err.message : String(err);
				}
				const durationMs = Date.now() - start;

				await recordInvocation(
					{
						id,
						tool: body.name,
						task_id: body.taskId,
						args: body.arguments ?? {},
						output,
						error,
						durationMs,
						createdAt: NOW(),
					},
					ctx,
				);
				if (body.taskId) {
					await appendTaskActivity(body.taskId, body.name, output, error, durationMs, ctx);
				}

				return error
					? { ok: false, tool: body.name, error, durationMs }
					: { ok: true, tool: body.name, output, durationMs };
			},
		},

		"invocations.list": {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const tool = getQueryParam(routeCtx, "tool");
				const task_id = getQueryParam(routeCtx, "task_id");
				const limit = Math.min(
					Math.max(parseInt(getQueryParam(routeCtx, "limit") ?? "50", 10) || 50, 1),
					500,
				);
				const filter: Record<string, WhereValue> = {};
				if (tool) filter.tool = tool;
				if (task_id) filter.task_id = task_id;
				const result = await ctx.storage.invocations!.query({
					where: Object.keys(filter).length > 0 ? filter : undefined,
					orderBy: { createdAt: "desc" },
					limit,
				});
				return { invocations: result.items.map((i) => i.data) };
			},
		},

		admin: {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const interaction = routeCtx.input as { type?: string; page?: string };
				if (interaction.type !== "page_load" || interaction.page !== "/tools") {
					return { blocks: [] };
				}
				const tools = listTools();
				const recent = await ctx.storage.invocations!.query({
					orderBy: { createdAt: "desc" },
					limit: 25,
				});
				return {
					blocks: [
						{ type: "header", text: "Tools" },
						{
							type: "context",
							elements: [
								{
									type: "text",
									text: "Tool registry consumed by the OpenRouter chat loop. The tools are the same primitives external MCP clients have, available to internal agents.",
								},
							],
						},
						{
							type: "stats",
							stats: [
								{ label: "Registered", value: String(tools.length) },
								{ label: "Recent invocations", value: String(recent.items.length) },
							],
						},
						{
							type: "table",
							blockId: "tools-list",
							columns: [
								{ key: "name", label: "Name", format: "text" },
								{ key: "description", label: "Description", format: "text" },
								{ key: "capabilities", label: "Capabilities", format: "text" },
							],
							rows: tools.map((t) => ({
								name: t.name,
								description:
									t.description.length > 100 ? t.description.slice(0, 97) + "…" : t.description,
								capabilities: (t.capabilities ?? []).join(", "),
							})),
						},
					],
				};
			},
		},
	},
});
