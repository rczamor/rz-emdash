/**
 * Shared types for the LLM router and its drivers.
 *
 * All drivers expose the same OpenAI-compat surface
 * (chat-completions / embeddings / models). Provider-specific
 * features live in optional `nativeRoutes` per driver.
 */

export interface ChatMessage {
	role: "system" | "user" | "assistant" | "tool";
	content: string | null;
	name?: string;
	tool_calls?: ChatToolCall[];
	tool_call_id?: string;
}

export interface ChatToolCall {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
}

export interface ToolSpec {
	type: "function";
	function: {
		name: string;
		description: string;
		parameters: Record<string, unknown>;
	};
}

export interface ChatCompletionInput {
	model: string;
	messages: ChatMessage[];
	temperature?: number;
	max_tokens?: number;
	top_p?: number;
	response_format?: { type: "json_object" | "text" };
	stop?: string[];
	stream?: false;
	tools?: ToolSpec[];
	tool_choice?: "auto" | "none" | { type: "function"; function: { name: string } };
}

export interface ChatCompletionResponse {
	id: string;
	model: string;
	created: number;
	choices: Array<{
		index: number;
		message: ChatMessage;
		finish_reason: string;
	}>;
	usage?: {
		prompt_tokens: number;
		completion_tokens: number;
		total_tokens: number;
	};
}

export interface EmbeddingsInput {
	model: string;
	input: string | string[];
}

export interface EmbeddingsResponse {
	data: Array<{ embedding: number[]; index: number }>;
	model: string;
	usage?: { prompt_tokens: number; total_tokens: number };
}

export interface ModelInfo {
	id: string;
	[key: string]: unknown;
}

/** Provider-agnostic call attribution. */
export interface CallContext {
	taskId?: string;
	agentId?: string;
}
