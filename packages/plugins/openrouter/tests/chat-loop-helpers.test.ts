import type { PluginContext } from "emdash";
import { describe, expect, it } from "vitest";

import { siteUrlFor, toolResultMessage } from "../src/chat-loop.js";
import type { RunChatLoopInput, ToolInvocation } from "../src/chat-loop.js";

const mkInput = (siteUrl?: string): RunChatLoopInput =>
	({
		completionInput: { model: "m", messages: [] },
		config: { apiKey: "k" },
		siteUrl,
	}) as RunChatLoopInput;

const mkCtx = (url: string | undefined): PluginContext =>
	({ site: url === undefined ? undefined : { url } }) as unknown as PluginContext;

describe("siteUrlFor", () => {
	it("prefers explicit input.siteUrl", () => {
		expect(siteUrlFor(mkInput("https://input.example"), mkCtx("https://ctx.example"))).toBe(
			"https://input.example",
		);
	});

	it("falls back to ctx.site.url", () => {
		expect(siteUrlFor(mkInput(), mkCtx("https://ctx.example"))).toBe("https://ctx.example");
	});

	it("falls back to localhost:4321 when neither is set", () => {
		expect(siteUrlFor(mkInput(), mkCtx(undefined))).toBe("http://localhost:4321");
	});

	it("strips trailing slash from input.siteUrl", () => {
		expect(siteUrlFor(mkInput("https://x.com/"), mkCtx(undefined))).toBe("https://x.com");
	});

	it("strips trailing slash from ctx.site.url", () => {
		expect(siteUrlFor(mkInput(), mkCtx("https://x.com/"))).toBe("https://x.com");
	});
});

describe("toolResultMessage", () => {
	const baseInv: ToolInvocation = {
		toolCallId: "call-1",
		name: "content_get",
		arguments: {},
	};

	it("encodes successful output as JSON", () => {
		const inv: ToolInvocation = { ...baseInv, output: { id: "post:1", title: "Hi" } };
		const msg = toolResultMessage(inv);
		expect(msg.role).toBe("tool");
		expect(msg.tool_call_id).toBe("call-1");
		expect(JSON.parse(msg.content)).toEqual({ id: "post:1", title: "Hi" });
	});

	it("emits null when output is missing", () => {
		const msg = toolResultMessage(baseInv);
		expect(JSON.parse(msg.content)).toBeNull();
	});

	it("emits a structured error envelope when error is present", () => {
		const inv: ToolInvocation = { ...baseInv, error: "boom" };
		const msg = toolResultMessage(inv);
		expect(JSON.parse(msg.content)).toEqual({ ok: false, error: "boom" });
	});

	it("error envelope wins over output if both are set", () => {
		const inv: ToolInvocation = { ...baseInv, output: "ignored", error: "first" };
		const msg = toolResultMessage(inv);
		expect(JSON.parse(msg.content)).toEqual({ ok: false, error: "first" });
	});
});
