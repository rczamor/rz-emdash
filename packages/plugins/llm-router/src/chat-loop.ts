/**
 * Provider-agnostic chat-loop.
 *
 * The router chooses an active driver at startup; this loop receives
 * the resolved DriverHandlers and uses them for the chatCompletion
 * call. Everything else — tool execution, cost recording, llm:*
 * event dispatch — is identical across drivers.
 */

import type { PluginContext } from "emdash";
import { dispatchEvent } from "@emdash-cms/plugin-automations/dispatch";

import type { DriverHandlers } from "./driver.js";
import type {
	ChatCompletionInput,
	ChatCompletionResponse,
	ChatMessage,
	ChatToolCall,
} from "./types.js";

const DEFAULT_MAX_ITERATIONS = 8;

export interface RunChatLoopInput {
	completionInput: ChatCompletionInput;
	driverId: string;
	handlers: DriverHandlers;
	maxIterations?: number;
	taskId?: string;
	agentId?: string;
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
	driverId: string,
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
				source: `llm-router:${driverId}`,
			}),
		});
	} catch (err) {
		ctx.log.warn("llm-router: failed to record cost on task", {
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

function dispatch(source: string, payload: Record<string, unknown>, ctx: PluginContext): Promise<void> {
	return dispatchEvent(source, payload, ctx).catch((err) => {
		ctx.log.warn("llm-router: llm event dispatch failed", {
			source,
			error: err instanceof Error ? err.message : String(err),
		});
	});
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
	const fetchImpl = ctx.http?.fetch.bind(ctx.http) ?? globalThis.fetch;
	const history: ChatMessage[] = [...input.completionInput.messages];
	const invocations: ToolInvocation[] = [];
	const totalCost = { tokensIn: 0, tokensOut: 0, calls: 0 };
	let terminated: RunChatLoopResult["terminated"] = "complete";
	let final: ChatMessage = { role: "assistant", content: "" };

	for (let i = 0; i < maxIterations; i++) {
		const callStart = Date.now();
		void dispatch("llm:call-started", {
			provider: input.driverId,
			model: input.completionInput.model,
			messages: history,
			tools: input.completionInput.tools,
			taskId: input.taskId,
			agentId: input.agentId,
			iteration: i,
			startedAt: new Date(callStart).toISOString(),
		}, ctx);

		let response: ChatCompletionResponse;
		try {
			response = await input.handlers.chatCompletion(
				{ ...input.completionInput, messages: history },
				fetchImpl,
			);
		} catch (err) {
			const errMsg = err instanceof Error ? err.message : String(err);
			ctx.log.error("llm-router: chat completion failed", {
				driverId: input.driverId,
				iteration: i,
				error: errMsg,
			});
			void dispatch("llm:call-failed", {
				provider: input.driverId,
				model: input.completionInput.model,
				taskId: input.taskId,
				agentId: input.agentId,
				iteration: i,
				error: errMsg,
				durationMs: Date.now() - callStart,
			}, ctx);
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
					input.driverId,
					response.usage.prompt_tokens,
					response.usage.completion_tokens,
					siteUrl,
					ctx,
				);
			}
		}

		void dispatch("llm:call-finished", {
			provider: input.driverId,
			model: input.completionInput.model,
			input: history,
			output: response.choices[0]?.message,
			usage: response.usage
				? {
						input: response.usage.prompt_tokens,
						output: response.usage.completion_tokens,
						total: response.usage.total_tokens,
					}
				: undefined,
			taskId: input.taskId,
			agentId: input.agentId,
			iteration: i,
			durationMs: Date.now() - callStart,
			finishReason: response.choices[0]?.finish_reason,
		}, ctx);

		const message = response.choices[0]?.message;
		if (!message) {
			terminated = "error";
			break;
		}

		if (!message.tool_calls || message.tool_calls.length === 0) {
			final = message;
			history.push(message);
			break;
		}

		history.push(message);
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

export function extractText(response: ChatCompletionResponse): string {
	return response.choices[0]?.message.content ?? "";
}
