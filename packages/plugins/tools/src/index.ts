/**
 * Tools Plugin for EmDash CMS — in-process tool registry for LLM
 * tool calling.
 *
 * Why this plugin exists:
 *
 *   EmDash core ships an MCP server with 33 tools at /_emdash/api/mcp,
 *   exposed to *external* MCP clients (Claude Desktop, Cursor). For
 *   *internal* agents — those orchestrated by the Tasks/Automations
 *   plugins via OpenRouter — those tools weren't reachable: there was
 *   no in-process catalog the OpenRouter chat loop could inject as
 *   `tools: [...]`, no per-agent allowlist, and no execution loop
 *   that runs tool calls and feeds results back to the model.
 *
 *   This plugin fills that gap. It exposes:
 *
 *     1. A built-in catalog wrapping the essentials (content_list,
 *        content_get, content_search, task_create, task_advance,
 *        memory_search, memory_put).
 *     2. A registry for plugins to add more tools at module-load time
 *        (`@emdash-cms/plugin-tools/registry`).
 *     3. A spec endpoint (`tools.openaiSpec`) returning the
 *        OpenAI-compatible `tools` array for direct injection into
 *        OpenRouter chat requests.
 *     4. An execution endpoint (`tools.invoke`) so the OpenRouter
 *        plugin can run tool calls and feed results back.
 *
 * Per-agent allowlist:
 *
 *   The Agents plugin's `agent.tools[]` lists which tool names this
 *   agent may call. `tools.openaiSpec?agent_id=writer-bot` returns
 *   the catalog filtered to that allowlist. Empty allowlist = all
 *   tools available (useful for system / human-driven runs).
 */

import type { PluginDescriptor } from "emdash";

export type { JsonSchema, OpenAITool, Tool, InvokeInput, InvokeResult } from "./types.js";
export { registerTool, getTool, listTools, listToolNames, unregisterTool } from "./registry.js";

export function toolsPlugin(): PluginDescriptor {
	return {
		id: "tools",
		version: "0.0.1",
		format: "standard",
		entrypoint: "@emdash-cms/plugin-tools/sandbox",
		options: {},
		// network:fetch — many built-in tools call other plugins via HTTP.
		// read/write content + media + users so tools can access them.
		capabilities: [
			"network:fetch",
			"read:content",
			"write:content",
			"read:media",
			"write:media",
			"read:users",
		],
		// Same-origin only by default. Override at install time if
		// your site lives on a different host.
		allowedHosts: ["localhost", "127.0.0.1", "*"],
		storage: {
			invocations: { indexes: ["tool", "task_id", "createdAt"] },
		},
		adminPages: [{ path: "/tools", label: "Tools", icon: "wrench" }],
	};
}
