/**
 * MCP-client types.
 *
 * The MCP HTTP transport spec is small. We model only what's needed
 * for tool discovery + invocation; prompts/resources are deferred.
 */

export interface McpServerConfig {
	id: string;
	name: string;
	url: string;
	auth?:
		| { kind: "bearer"; token: string }
		| { kind: "basic"; username: string; password: string };
	/** Restrict the server's tools to this set of agent ids. Empty = global. */
	agent_ids?: string[];
	/** Tool names to allow; empty = all advertised tools. */
	allow_tools?: string[];
	created_at: string;
	updated_at: string;
}

export interface McpTool {
	name: string;
	description?: string;
	inputSchema?: Record<string, unknown>;
}

export interface McpToolCallResponse {
	content?: Array<{ type: string; text?: string; data?: unknown }>;
	isError?: boolean;
}

export interface McpToolsListResponse {
	tools: McpTool[];
}
