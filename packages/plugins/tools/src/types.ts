/**
 * Tool types — OpenAI-compatible function-calling schema.
 *
 * The runtime catalog matches the OpenAI / OpenRouter `tools` request
 * field exactly so we can pass it straight through to the model
 * without translation. The actual execution happens here in the
 * plugin via the registered handler.
 */

import type { PluginContext } from "emdash";

export interface JsonSchema {
	type?: string;
	description?: string;
	enum?: unknown[];
	items?: JsonSchema;
	properties?: Record<string, JsonSchema>;
	required?: string[];
	additionalProperties?: boolean | JsonSchema;
	[key: string]: unknown;
}

export interface Tool {
	name: string;
	description: string;
	/** JSON Schema describing the tool's input arguments. */
	parameters: JsonSchema;
	/** EmDash plugin capabilities required to invoke. Advisory in trusted mode, enforced in sandbox. */
	capabilities?: string[];
	handler: (args: Record<string, unknown>, ctx: PluginContext) => Promise<unknown>;
}

/** OpenAI / OpenRouter wire-format. Returned by `tools.openaiSpec`. */
export interface OpenAITool {
	type: "function";
	function: {
		name: string;
		description: string;
		parameters: JsonSchema;
	};
}

export interface InvokeInput {
	name: string;
	arguments: Record<string, unknown>;
	taskId?: string;
}

export interface InvokeResult {
	ok: boolean;
	tool: string;
	output?: unknown;
	error?: string;
	durationMs?: number;
}
