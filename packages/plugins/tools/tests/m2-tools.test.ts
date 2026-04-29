/**
 * M2 — content / media / web / scoring tools.
 *
 * Built-in tools register via top-level side effect on
 * `registerBuiltInTools()` import; the runs harness invokes them via
 * the registered Tool record. Tests exercise the handler directly.
 */

import type { PluginContext } from "emdash";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { _resetTools, getTool, listToolNames } from "../src/registry.js";
import { registerBuiltInTools } from "../src/built-ins.js";

beforeEach(() => {
	_resetTools();
	registerBuiltInTools();
});

function fakeCtx(overrides: Partial<PluginContext> = {}): PluginContext {
	return {
		plugin: { id: "test", version: "0.0.1" },
		storage: {} as PluginContext["storage"],
		kv: { get: async () => null, set: async () => {}, delete: async () => false, list: async () => [] },
		log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as PluginContext["log"],
		site: { url: "http://localhost:4321" } as unknown as PluginContext["site"],
		url: (p: string) => `http://localhost:4321${p}`,
		...overrides,
	} as PluginContext;
}

describe("registry — M2 surface", () => {
	it("registers all M2 tools", () => {
		const names = listToolNames();
		expect(names).toContain("content_create");
		expect(names).toContain("content_update");
		expect(names).toContain("content_publish");
		expect(names).toContain("content_schedule");
		expect(names).toContain("content_delete");
		expect(names).toContain("media_upload");
		expect(names).toContain("media_delete");
		expect(names).toContain("web_fetch");
		expect(names).toContain("seo_score");
		expect(names).toContain("readability_score");
	});
});

describe("content_create", () => {
	it("forces status=draft on create", async () => {
		const create = vi.fn(async (_c: string, data: Record<string, unknown>) => ({
			id: "p1",
			...data,
		}));
		const ctx = fakeCtx({
			content: { create, get: async () => null, list: async () => ({ items: [], hasMore: false }) } as unknown as PluginContext["content"],
		});
		await getTool("content_create")!.handler(
			{ collection: "posts", data: { title: "X", status: "published" } },
			ctx,
		);
		expect(create).toHaveBeenCalledWith("posts", expect.objectContaining({ status: "draft" }));
	});

	it("throws when write:content capability is missing", async () => {
		const ctx = fakeCtx();
		await expect(
			getTool("content_create")!.handler({ collection: "posts", data: {} }, ctx),
		).rejects.toThrow(/write:content/);
	});
});

describe("content_update", () => {
	it("updates a draft directly", async () => {
		const update = vi.fn(async (_c: string, _id: string, data: Record<string, unknown>) => ({
			id: "p1",
			...data,
		}));
		const ctx = fakeCtx({
			content: {
				get: async () => ({ status: "draft" }),
				update,
				list: async () => ({ items: [], hasMore: false }),
			} as unknown as PluginContext["content"],
		});
		const result = await getTool("content_update")!.handler(
			{ collection: "posts", id: "p1", data: { title: "Updated" } },
			ctx,
		);
		expect(update).toHaveBeenCalled();
		expect(result).toMatchObject({ id: "p1", title: "Updated" });
	});

	it("pauses for approval when target is published", async () => {
		const update = vi.fn();
		const ctx = fakeCtx({
			content: {
				get: async () => ({ status: "published" }),
				update,
				list: async () => ({ items: [], hasMore: false }),
			} as unknown as PluginContext["content"],
		});
		const result = (await getTool("content_update")!.handler(
			{ collection: "posts", id: "p1", data: { title: "X" } },
			ctx,
		)) as { ok: boolean; paused_for_human?: { tool: string; reason: string } };
		expect(result.ok).toBe(false);
		expect(result.paused_for_human?.tool).toBe("content_update");
		expect(update).not.toHaveBeenCalled();
	});
});

describe("content_publish", () => {
	it("always pauses for approval", async () => {
		const ctx = fakeCtx();
		const result = (await getTool("content_publish")!.handler(
			{ collection: "posts", id: "p1" },
			ctx,
		)) as { ok: boolean; paused_for_human: { tool: string; args: Record<string, unknown> } };
		expect(result.ok).toBe(false);
		expect(result.paused_for_human.tool).toBe("content_publish");
		expect((result.paused_for_human.args.data as { status: string }).status).toBe("published");
	});
});

describe("content_delete and media_delete", () => {
	it.each(["content_delete", "media_delete"])("%s always pauses for approval", async (tool) => {
		const ctx = fakeCtx();
		const args = tool === "content_delete" ? { collection: "posts", id: "p1" } : { id: "m1" };
		const result = (await getTool(tool)!.handler(args, ctx)) as { ok: boolean };
		expect(result.ok).toBe(false);
	});
});

describe("content_schedule", () => {
	it("sets scheduled_at via update", async () => {
		const update = vi.fn(async (_c: string, _id: string, data: Record<string, unknown>) => ({
			id: "p1",
			...data,
		}));
		const ctx = fakeCtx({
			content: { get: async () => null, update, list: async () => ({ items: [], hasMore: false }) } as unknown as PluginContext["content"],
		});
		await getTool("content_schedule")!.handler(
			{ collection: "posts", id: "p1", scheduled_at: "2026-05-01T00:00:00Z" },
			ctx,
		);
		expect(update).toHaveBeenCalledWith("posts", "p1", { scheduled_at: "2026-05-01T00:00:00Z" });
	});
});

describe("media_upload", () => {
	it("fetches source_url and forwards bytes to media.upload", async () => {
		const upload = vi.fn(async () => ({ mediaId: "m1", url: "https://cdn/m1" }));
		const fetchFn = vi.fn(async () =>
			new Response(new Uint8Array([1, 2, 3]).buffer, { status: 200 }),
		);
		const ctx = fakeCtx({
			media: { upload, get: async () => null, list: async () => ({ items: [], hasMore: false }) } as unknown as PluginContext["media"],
			http: { fetch: fetchFn as unknown as typeof fetch },
		});
		const result = await getTool("media_upload")!.handler(
			{ filename: "x.png", contentType: "image/png", source_url: "https://example.com/x.png" },
			ctx,
		);
		expect(fetchFn).toHaveBeenCalledWith("https://example.com/x.png");
		expect(upload).toHaveBeenCalledWith("x.png", "image/png", expect.any(ArrayBuffer));
		expect(result).toEqual({ mediaId: "m1", url: "https://cdn/m1" });
	});

	it("decodes bytes_base64 alternative", async () => {
		const upload = vi.fn(async () => ({ mediaId: "m1", url: "https://cdn/m1" }));
		const ctx = fakeCtx({
			media: { upload, get: async () => null, list: async () => ({ items: [], hasMore: false }) } as unknown as PluginContext["media"],
			http: { fetch: (async () => new Response()) as unknown as typeof fetch },
		});
		const b64 = Buffer.from([10, 20, 30]).toString("base64");
		await getTool("media_upload")!.handler(
			{ filename: "x.bin", contentType: "application/octet-stream", bytes_base64: b64 },
			ctx,
		);
		expect(upload).toHaveBeenCalled();
		const bytes = upload.mock.calls[0]?.[2] as ArrayBuffer;
		expect(new Uint8Array(bytes)).toEqual(new Uint8Array([10, 20, 30]));
	});

	it("rejects when neither source_url nor bytes_base64 supplied", async () => {
		const ctx = fakeCtx({
			media: { upload: async () => ({}) } as unknown as PluginContext["media"],
			http: { fetch: (async () => new Response()) as unknown as typeof fetch },
		});
		await expect(
			getTool("media_upload")!.handler({ filename: "x", contentType: "image/png" }, ctx),
		).rejects.toThrow(/source_url or bytes_base64/);
	});
});

describe("web_fetch", () => {
	it("returns text body up to max_chars", async () => {
		const long = "a".repeat(50000);
		const ctx = fakeCtx({
			http: {
				fetch: async () =>
					new Response(long, { status: 200, headers: { "content-type": "text/plain" } }),
			} as PluginContext["http"],
		});
		const result = (await getTool("web_fetch")!.handler(
			{ url: "https://example.com", max_chars: 100 },
			ctx,
		)) as { ok: boolean; body: string; truncated: boolean; length: number };
		expect(result.body).toHaveLength(100);
		expect(result.truncated).toBe(true);
		expect(result.length).toBe(50000);
	});

	it("returns ok:false on non-2xx", async () => {
		const ctx = fakeCtx({
			http: { fetch: async () => new Response("nope", { status: 500 }) } as PluginContext["http"],
		});
		const result = (await getTool("web_fetch")!.handler({ url: "https://x" }, ctx)) as {
			ok: boolean;
			status?: number;
		};
		expect(result.ok).toBe(false);
		expect(result.status).toBe(500);
	});
});

describe("readability_score", () => {
	it("scores plain English at expected ranges", async () => {
		const result = (await getTool("readability_score")!.handler(
			{
				text: "The cat sat on the mat. The dog ran fast. Birds fly high. Fish swim deep.",
			},
			fakeCtx(),
		)) as { flesch_reading_ease: number; words: number; sentences: number; reading_minutes: number };
		expect(result.flesch_reading_ease).toBeGreaterThan(70);
		expect(result.words).toBe(16);
		expect(result.sentences).toBe(4);
	});

	it("strips HTML before scoring", async () => {
		const a = (await getTool("readability_score")!.handler(
			{ text: "<p>Hello world.</p>" },
			fakeCtx(),
		)) as { words: number };
		expect(a.words).toBe(2);
	});
});

describe("seo_score", () => {
	it("returns 100 for a well-formed input", async () => {
		const result = (await getTool("seo_score")!.handler(
			{
				title: "An Excellent Eight-Word Title For Our Product Launch Today",
				description:
					"A meta description that's just the right length to fit nicely in search-engine result page snippets.",
				slug: "product-launch-2026",
				body: "This is a properly long body. ".repeat(80),
			},
			fakeCtx(),
		)) as { score: number; findings: Array<{ severity: string }> };
		expect(result.score).toBeGreaterThanOrEqual(95);
		expect(result.findings.filter((f) => f.severity === "fail")).toHaveLength(0);
	});

	it("flags missing title as fail", async () => {
		const result = (await getTool("seo_score")!.handler(
			{ title: "", description: "x", body: "x" },
			fakeCtx(),
		)) as { score: number; findings: Array<{ severity: string }> };
		expect(result.score).toBeLessThan(80);
		expect(result.findings.some((f) => f.severity === "fail")).toBe(true);
	});

	it("warns on short body", async () => {
		const result = (await getTool("seo_score")!.handler(
			{
				title: "Title that is the right length for SEO purposes",
				description: "Description that is the right length for SEO purposes too",
				body: "short",
				slug: "x",
			},
			fakeCtx(),
		)) as { findings: Array<{ severity: string; message: string }> };
		expect(result.findings.some((f) => f.message.includes("short"))).toBe(true);
	});
});
