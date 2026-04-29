/**
 * MCP-client — runtime entrypoint.
 *
 * Routes:
 *   POST  servers.register   { name, url, auth?, agent_ids?, allow_tools? }
 *   POST  servers.unregister { id }
 *   POST  servers.refresh    { id } — re-discover tools
 *   GET   servers.list
 *   GET   servers.tools?id=<server>  — list bridged tool names
 *
 * On every tick the plugin doesn't actively poll; tool discovery
 * happens at register time and on explicit `servers.refresh`. A
 * future milestone can add periodic refresh via the scheduler.
 */

import { definePlugin } from "emdash";
import type { PluginContext } from "emdash";

import { listTools } from "./client.js";
import { bridgeServerTools, unbridgeServer } from "./tool-bridge.js";
import type { McpServerConfig } from "./types.js";

interface RouteCtx {
	input: unknown;
	request: Request;
}

const NOW = (): string => new Date().toISOString();

function newServerId(): string {
	return `mcp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function getQueryParam(routeCtx: RouteCtx, key: string): string | undefined {
	return new URL(routeCtx.request.url).searchParams.get(key) ?? undefined;
}

/**
 * Tool-cache: maps server_id → bridged tool names. Stored in the
 * `tool_cache` collection so a cold-boot can re-bridge from the
 * persisted advertised list without re-querying every server.
 */
interface ToolCacheEntry {
	server_id: string;
	bridged_names: string[];
	advertised: Array<{ name: string; description?: string }>;
	cached_at: string;
}

async function persistServer(server: McpServerConfig, ctx: PluginContext): Promise<void> {
	await ctx.storage.servers!.put(server.id, server);
}

async function loadServer(id: string, ctx: PluginContext): Promise<McpServerConfig | null> {
	return ((await ctx.storage.servers!.get(id)) as McpServerConfig | null) ?? null;
}

async function discoverAndBridge(
	server: McpServerConfig,
	ctx: PluginContext,
): Promise<{ bridged: string[]; advertised: number }> {
	let tools;
	try {
		tools = await listTools(server, globalThis.fetch);
	} catch (err) {
		ctx.log.warn(`MCP discovery failed for ${server.name}`, {
			error: err instanceof Error ? err.message : String(err),
		});
		return { bridged: [], advertised: 0 };
	}

	const bridged = bridgeServerTools(server, tools);
	const cache: ToolCacheEntry = {
		server_id: server.id,
		bridged_names: bridged,
		advertised: tools.map((t) => ({ name: t.name, description: t.description })),
		cached_at: NOW(),
	};
	await ctx.storage.tool_cache!.put(server.id, cache);
	return { bridged, advertised: tools.length };
}

export default definePlugin({
	hooks: {
		"plugin:install": {
			handler: async (_event: unknown, ctx: PluginContext) => {
				ctx.log.info("MCP client plugin installed");
				// Cold-boot recovery: re-bridge every server's cached tools so
				// the in-memory tools registry knows about them after a
				// restart. (We don't re-discover on cold-boot — that would
				// fan out to every server on every isolate spin-up. Refresh
				// is explicit.)
				const result = await ctx.storage.servers!.query({ limit: 500 });
				for (const item of result.items) {
					const server = item.data as McpServerConfig;
					const cache = (await ctx.storage.tool_cache!.get(server.id)) as ToolCacheEntry | null;
					if (cache?.advertised && cache.advertised.length > 0) {
						const tools = cache.advertised.map((t) => ({
							name: t.name,
							description: t.description,
						}));
						bridgeServerTools(server, tools);
					}
				}
			},
		},
	},

	routes: {
		"servers.register": {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const body = routeCtx.input as Partial<McpServerConfig> | null;
				if (!body || typeof body !== "object") return { ok: false, error: "Invalid input" };
				if (!body.name || !body.url) return { ok: false, error: "name and url required" };
				try {
					new URL(body.url);
				} catch {
					return { ok: false, error: "url must be a valid URL" };
				}
				const server: McpServerConfig = {
					id: body.id ?? newServerId(),
					name: body.name,
					url: body.url,
					auth: body.auth,
					agent_ids: body.agent_ids,
					allow_tools: body.allow_tools,
					created_at: NOW(),
					updated_at: NOW(),
				};
				await persistServer(server, ctx);
				const { bridged, advertised } = await discoverAndBridge(server, ctx);
				return { ok: true, server, bridged, advertised };
			},
		},

		"servers.unregister": {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const body = routeCtx.input as { id?: string } | null;
				if (!body?.id) return { ok: false, error: "id required" };
				const cache = (await ctx.storage.tool_cache!.get(body.id)) as ToolCacheEntry | null;
				if (cache?.bridged_names) unbridgeServer(cache.bridged_names);
				await ctx.storage.tool_cache!.delete(body.id);
				const removed = await ctx.storage.servers!.delete(body.id);
				return { ok: true, removed };
			},
		},

		"servers.refresh": {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const body = routeCtx.input as { id?: string } | null;
				if (!body?.id) return { ok: false, error: "id required" };
				const server = await loadServer(body.id, ctx);
				if (!server) return { ok: false, error: "Not found" };
				// Tear down old bridges first.
				const oldCache = (await ctx.storage.tool_cache!.get(body.id)) as ToolCacheEntry | null;
				if (oldCache?.bridged_names) unbridgeServer(oldCache.bridged_names);
				const { bridged, advertised } = await discoverAndBridge(server, ctx);
				return { ok: true, bridged, advertised };
			},
		},

		"servers.list": {
			handler: async (_routeCtx: RouteCtx, ctx: PluginContext) => {
				const result = await ctx.storage.servers!.query({
					orderBy: { created_at: "desc" },
					limit: 200,
				});
				return { ok: true, servers: result.items.map((i) => i.data) };
			},
		},

		"servers.tools": {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const id = getQueryParam(routeCtx, "id");
				if (!id) return { ok: false, error: "id required" };
				const cache = (await ctx.storage.tool_cache!.get(id)) as ToolCacheEntry | null;
				if (!cache) return { ok: false, error: "No cached tools — call servers.refresh" };
				return { ok: true, tools: cache.advertised, bridged: cache.bridged_names };
			},
		},

		admin: {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const interaction = routeCtx.input as { type?: string; page?: string };
				if (interaction.type !== "page_load" || interaction.page !== "/mcp") {
					return { blocks: [] };
				}
				const result = await ctx.storage.servers!.query({
					orderBy: { created_at: "desc" },
					limit: 100,
				});
				return {
					blocks: [
						{ type: "header", text: "MCP servers" },
						{
							type: "table",
							blockId: "mcp-servers",
							columns: [
								{ key: "id", label: "ID", format: "text" },
								{ key: "name", label: "Name", format: "text" },
								{ key: "url", label: "URL", format: "text" },
								{ key: "created_at", label: "Added", format: "relative_time" },
							],
							rows: result.items.map((i) => {
								const s = i.data as McpServerConfig;
								return {
									id: s.id,
									name: s.name,
									url: s.url,
									created_at: s.created_at,
								};
							}),
						},
					],
				};
			},
		},
	},
});
