/**
 * Bridge MCP tools into the EmDash tools registry.
 *
 * On server registration, we discover the tools (`tools/list`) and
 * for each one register a synthetic `Tool` with name
 * `mcp:<server-id>:<tool-name>`. Its handler proxies to `callTool`,
 * carrying the originating server config and the request's plugin
 * context. The agent's allowlist sees these as ordinary tool names —
 * no special-case in `tools.invoke` needed.
 */

import { registerTool, unregisterTool } from "@emdash-cms/plugin-tools/registry";
import type { Tool } from "@emdash-cms/plugin-tools";

import { callTool, extractText } from "./client.js";
import type { McpServerConfig, McpTool } from "./types.js";

/**
 * Format the synthetic tool name. The colon separator is stable
 * across the codebase (mirrors `email:send`, `llm:call-finished`).
 */
export function bridgedToolName(serverId: string, toolName: string): string {
	return `mcp:${serverId}:${toolName}`;
}

function buildBridgedTool(server: McpServerConfig, mcpTool: McpTool): Tool {
	const name = bridgedToolName(server.id, mcpTool.name);
	return {
		name,
		description:
			mcpTool.description ??
			`MCP tool from ${server.name} (${server.id}): ${mcpTool.name}`,
		parameters: (mcpTool.inputSchema as Record<string, unknown>) ?? {
			type: "object",
			properties: {},
		},
		// MCP servers are operator-configured; their tools share the
		// `network:fetch` capability since calling them requires HTTP.
		capabilities: ["network:fetch"],
		handler: async (args, _ctx) => {
			const response = await callTool(server, mcpTool.name, args);
			if (response.isError) {
				return { ok: false, error: extractText(response) || "MCP tool returned an error" };
			}
			// Surface the response.content untouched so agents can read
			// structured payloads (text, image base64, embedded JSON).
			return { ok: true, content: response.content ?? [] };
		},
	};
}

/**
 * Register every advertised tool from an MCP server as a synthetic
 * Tool. Filters by `allow_tools` if set. Returns the synthetic names
 * registered so we can unregister them on server removal.
 */
export function bridgeServerTools(server: McpServerConfig, tools: McpTool[]): string[] {
	const allow = new Set(server.allow_tools ?? []);
	const registered: string[] = [];
	for (const tool of tools) {
		if (allow.size > 0 && !allow.has(tool.name)) continue;
		const bridged = buildBridgedTool(server, tool);
		registerTool(bridged);
		registered.push(bridged.name);
	}
	return registered;
}

/** Tear down all synthetic tools previously registered for this server. */
export function unbridgeServer(toolNames: string[]): void {
	for (const name of toolNames) unregisterTool(name);
}
