/**
 * Built-in action runners.
 *
 * Each runner returns void on success or throws on failure. The engine
 * catches thrown errors and records them on the routine's stats.
 */

import type { PluginContext } from "emdash";
import { resolveTokens } from "@emdash-cms/plugin-tokens/resolver";

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

export async function runAction(
	action: Action,
	tokenCtx: Record<string, unknown>,
	ctx: PluginContext,
): Promise<void> {
	switch (action.type) {
		case "email":
			return runEmail(action, tokenCtx, ctx);
		case "webhook":
			return runWebhook(action, tokenCtx, ctx);
		case "log":
			return runLog(action, tokenCtx, ctx);
		case "kv:set":
			return runKvSet(action, tokenCtx, ctx);
	}
}
