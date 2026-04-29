/**
 * MCP-client plugin for EmDash.
 *
 * EmDash already exposes itself as an MCP server (`/_emdash/api/mcp`).
 * This plugin is the **client** half: operators register external
 * MCP servers (GitHub, Notion, Slack, internal), and their tools are
 * auto-bridged into the existing tools registry as
 * `mcp:<server-id>:<tool>` so agents call them like any other tool.
 *
 * Out of scope for M6: prompts/* and resources/* MCP capabilities.
 * Real-world MCP servers mostly use tools, so the smaller surface
 * ships value sooner. Add prompt/resource bridging in a follow-up.
 */

import type { PluginDescriptor } from "emdash";

export type { McpServerConfig, McpTool, McpToolCallResponse } from "./types.js";
export { listTools, callTool, extractText } from "./client.js";
export { bridgeServerTools, unbridgeServer, bridgedToolName } from "./tool-bridge.js";

export interface McpClientPluginOptions {
	/** Re-discover tools every N minutes. Default: 0 (manual via servers.refresh). */
	refreshIntervalMinutes?: number;
}

export function mcpClientPlugin(_options: McpClientPluginOptions = {}): PluginDescriptor {
	return {
		id: "mcp-client",
		version: "0.0.1",
		format: "standard",
		entrypoint: "@emdash-cms/plugin-mcp-client/sandbox",
		options: {},
		capabilities: ["network:fetch"],
		// MCP servers are operator-configured; we accept any host they
		// register. For tighter security, operators should run this in
		// trusted mode.
		allowedHosts: ["*"],
		storage: {
			servers: { indexes: ["name", "created_at"] },
			tool_cache: { indexes: ["server_id"] },
		},
		adminPages: [{ path: "/mcp", label: "MCP servers", icon: "plug" }],
	};
}
