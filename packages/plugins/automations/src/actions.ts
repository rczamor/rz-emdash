/**
 * Built-in action runners. Each is registered in the pluggable
 * registry at module load. Other plugins or user code can register
 * additional action types via `@emdash-cms/plugin-automations/registry`.
 */

import { resolveTokens } from "@emdash-cms/plugin-tokens/resolver";
import type { PluginContext } from "emdash";

import { _registerBuiltin, getAction } from "./registry.js";
import type { Action, EmailAction, KvSetAction, LogAction, WebhookAction } from "./types.js";

async function r(input: string, ctx: Record<string, unknown>): Promise<string> {
	return resolveTokens(input, ctx);
}

async function runEmail(
	a: EmailAction,
	tokenCtx: Record<string, unknown>,
	ctx: PluginContext,
): Promise<void> {
	if (!ctx.email) throw new Error("email:send capability missing or no provider configured");
	const [to, subject, body] = await Promise.all([
		r(a.to, tokenCtx),
		r(a.subject, tokenCtx),
		r(a.body, tokenCtx),
	]);
	await ctx.email.send({ to, subject, text: body });
}

async function runWebhook(
	a: WebhookAction,
	tokenCtx: Record<string, unknown>,
	ctx: PluginContext,
): Promise<void> {
	if (!ctx.http) throw new Error("network:fetch capability missing");
	const url = await r(a.url, tokenCtx);
	const body = a.body != null ? await r(a.body, tokenCtx) : undefined;
	const headers: Record<string, string> = {};
	if (a.headers) {
		for (const [k, v] of Object.entries(a.headers)) {
			headers[k] = await r(v, tokenCtx);
		}
	}
	if (body && !headers["Content-Type"] && !headers["content-type"]) {
		headers["Content-Type"] = "application/json";
	}
	const res = await ctx.http.fetch(url, {
		method: a.method ?? "POST",
		headers,
		body,
	});
	if (!res.ok) {
		const text = await res.text().catch(() => "<unreadable>");
		throw new Error(`Webhook returned ${res.status}: ${text.slice(0, 200)}`);
	}
}

async function runLog(
	a: LogAction,
	tokenCtx: Record<string, unknown>,
	ctx: PluginContext,
): Promise<void> {
	const message = await r(a.message, tokenCtx);
	const level = a.level ?? "info";
	ctx.log[level](message, a.data);
}

async function runKvSet(
	a: KvSetAction,
	tokenCtx: Record<string, unknown>,
	ctx: PluginContext,
): Promise<void> {
	const key = await r(a.key, tokenCtx);
	let value: unknown = a.value;
	if (typeof value === "string") {
		value = await r(value, tokenCtx);
	}
	await ctx.kv.set(key, value);
}

// Seed the registry on module load.
_registerBuiltin<EmailAction>("email", runEmail);
_registerBuiltin<WebhookAction>("webhook", runWebhook);
_registerBuiltin<LogAction>("log", runLog);
_registerBuiltin<KvSetAction>("kv:set", runKvSet);

/**
 * Run any registered action. Throws if the action type is unknown.
 */
export async function runAction(
	action: Action,
	tokenCtx: Record<string, unknown>,
	ctx: PluginContext,
): Promise<void> {
	const runner = getAction(action.type);
	if (!runner) throw new Error(`Unknown action type: ${action.type}`);
	await runner(action, tokenCtx, ctx);
}
