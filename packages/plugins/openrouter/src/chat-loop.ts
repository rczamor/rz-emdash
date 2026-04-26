/**
 * Tool-calling chat loop.
 *
 * OpenAI's tool-call protocol is iterative: the model returns
 * `tool_calls` instead of finishing; the caller executes them, sends
 * results back as `role: "tool"` messages, and resubmits. The loop
 * terminates when the model returns a normal assistant message
 * without `tool_calls`, or when the iteration limit is reached.
 *
 * This module wraps that loop. Inputs:
 *   - the standard chat completion request
 *   - a `taskId` for cost attribution (optional)
 *   - a `siteUrl` so tool invocations resolve to the right host
 *
 * Outputs:
 *   - the final assistant message
 *   - the full message history (useful for debugging)
 *   - aggregate cost (across every model call)
 *   - the list of tool invocations performed
 */

import type { PluginContext } from "emdash";

import {
	chatCompletion,
	type ChatCompletionInput,
	type ChatCompletionResponse,
	type ChatMessage,
	type ChatToolCall,
	type OpenRouterConfig,
} from "./client.js";

const DEFAULT_MAX_ITERATIONS = 8;

export interface RunChatLoopInput {
	completionInput: ChatCompletionInput;
	config: OpenRouterConfig;
	maxIterations?: number;
	/** Task to attribute costs and tool calls to. */
	taskId?: string;
	/** Base URL for tools.invoke and tasks.cost.record. Defaults to ctx.site.url. */
	siteUrl?: string;
}

export interface ToolInvocation {
	toolCallId: string;
	name: string;
	arguments: Record<string, unknown>;
	output?: unknown;
	error?: string;
	durationMs?: number;
}

export interface RunChatLoopResult {
	final: ChatMessage;
	history: ChatMessage[];
	totalCost: { tokensIn: number; tokensOut: number; calls: number };
	invocations: ToolInvocation[];
	terminated: "complete" | "max_iterations" | "error";
}

function siteUrlFor(input: RunChatLoopInput, ctx: PluginContext): string {
	if (input.siteUrl) return input.siteUrl.replace(/\/$/, "");
	return (((ctx.site as { url?: string } | undefined)?.url ?? "http://localhost:4321") as string).replace(/\/$/, "");
}

async function recordCostOnTask(
	taskId: string,
	model: string,
	tokensIn: number,
	tokensOut: number,
	siteUrl: string,
	ctx: PluginContext,
): Promise<void> {
	if (!ctx.http) return;
	try {
		await ctx.http.fetch(`${siteUrl}/_emdash/api/plugins/tasks/cost.record`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				id: taskId,
				model,
				tokensIn,
				tokensOut,
				source: "openrouter",
			}),
		});
	} catch (err) {
		ctx.log.warn("OpenRouter: failed to record cost on task", {
			taskId,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

async function invokeOneTool(
	toolCall: ChatToolCall,
	taskId: string | undefined,
	siteUrl: string,
	ctx: PluginContext,
): Promise<ToolInvocation> {
	const inv: ToolInvocation = {
		toolCallId: toolCall.id,
		name: toolCall.function.name,
		arguments: {},
	};
	let parsedArgs: Record<string, unknown> = {};
	try {
		parsedArgs = JSON.parse(toolCall.function.arguments || "{}") as Record<string, unknown>;
	} catch (err) {
		inv.error = `Failed to parse tool arguments: ${err instanceof Error ? err.message : String(err)}`;
		return inv;
	}
	inv.arguments = parsedArgs;

	if (!ctx.http) {
		inv.error = "network:fetch capability missing";
		return inv;
	}

	const start = Date.now();
	try {
		const res = await ctx.http.fetch(`${siteUrl}/_emdash/api/plugins/tools/tools.invoke`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				name: toolCall.function.name,
				arguments: parsedArgs,
				taskId,
			}),
		});
		inv.durationMs = Date.now() - start;
		if (!res.ok) {
			inv.error = `tools.invoke returned ${res.status}`;
			return inv;
		}
		const json = (await res.json()) as { data?: { ok?: boolean; output?: unknown; error?: string } };
		const data = json.data ?? {};
		if (data.ok === false) {
			inv.error = data.error ?? "Unknown error";
		} else {
			inv.output = data.output;
		}
	} catch (err) {
		inv.error = err instanceof Error ? err.message : String(err);
	}
	return inv;
}

function toolResultMessage(inv: ToolInvocation): ChatMessage {
	const content = inv.error
		? JSON.stringify({ ok: false, error: inv.error })
		: JSON.stringify(inv.output ?? null);
	return {
		role: "tool",
		tool_call_id: inv.toolCallId,
		content,
	};
}

export async function runChatLoop(
	input: RunChatLoopInput,
	ctx: PluginContext,
): Promise<RunChatLoopResult> {
	const maxIterations = input.maxIterations ?? DEFAULT_MAX_ITERATIONS;
	const siteUrl = siteUrlFor(input, ctx);
	const history: ChatMessage[] = [...input.completionInput.messages];
	const invocations: ToolInvocation[] = [];
	const totalCost = { tokensIn: 0, tokensOut: 0, calls: 0 };
	let terminated: RunChatLoopResult["terminated"] = "complete";
	let final: ChatMessage = { role: "assistant", content: "" };

	for (let i = 0; i < maxIterations; i++) {
		let response: ChatCompletionResponse;
		try {
			response = await chatCompletion(
				{ ...input.completionInput, messages: history },
				input.config,
			);
		} catch (err) {
			ctx.log.error("OpenRouter: chat completion failed", {
				iteration: i,
				error: err instanceof Error ? err.message : String(err),
			});
			terminated = "error";
			break;
		}

		if (response.usage) {
			totalCost.tokensIn += response.usage.prompt_tokens;
			totalCost.tokensOut += response.usage.completion_tokens;
			totalCost.calls += 1;
			if (input.taskId) {
				await recordCostOnTask(
					input.taskId,
					input.completionInput.model,
					response.usage.prompt_tokens,
					response.usage.completion_tokens,
					siteUrl,
					ctx,
				);
			}
		}

		const message = response.choices[0]?.message;
		if (!message) {
			terminated = "error";
			break;
		}

		// No tool calls — done.
		if (!message.tool_calls || message.tool_calls.length === 0) {
			final = message;
			history.push(message);
			break;
		}

		// Append the assistant message with tool_calls to history.
		history.push(message);

		// Execute each tool call in parallel. The model expects all
		// tool_call_ids to be answered before resubmission.
		const results = await Promise.all(
			message.tool_calls.map((tc) => invokeOneTool(tc, input.taskId, siteUrl, ctx)),
		);
		invocations.push(...results);
		for (const inv of results) {
			history.push(toolResultMessage(inv));
		}

		if (i === maxIterations - 1) {
			terminated = "max_iterations";
			final = {
				role: "assistant",
				content: `(Hit max-iterations limit of ${maxIterations}; partial progress only.)`,
			};
		}
	}

	return { final, history, totalCost, invocations, terminated };
}
