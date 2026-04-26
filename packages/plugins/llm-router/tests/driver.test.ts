import { describe, it, expect, beforeEach } from "vitest";

import {
	getDriver,
	listDrivers,
	registerDriver,
	resolveActiveDriver,
	type Driver,
} from "../src/driver.js";
import { openrouterDriver } from "../src/drivers/openrouter.js";
import { tensorzeroDriver } from "../src/drivers/tensorzero.js";
import { litellmDriver } from "../src/drivers/litellm.js";

function makeDriver(id: string, detectKey: string): Driver {
	return {
		id,
		name: id,
		configFromEnv: (env) => ({ apiKey: env[detectKey] }),
		detect: (env) => Boolean(env[detectKey]),
		build: () => {
			throw new Error("not used");
		},
	};
}

describe("registerDriver / getDriver / listDrivers", () => {
	beforeEach(() => {
		// Drivers persist across tests; we just register fresh ids per case.
	});

	it("registers and retrieves by id", () => {
		const d = makeDriver("test-a", "TEST_A");
		registerDriver(d);
		expect(getDriver("test-a")).toBe(d);
	});

	it("listDrivers preserves registration order", () => {
		registerDriver(makeDriver("ord-1", "X1"));
		registerDriver(makeDriver("ord-2", "X2"));
		const ids = listDrivers().map((d) => d.id);
		expect(ids.indexOf("ord-1")).toBeLessThan(ids.indexOf("ord-2"));
	});

	it("re-registering does not duplicate ordering", () => {
		const d1 = makeDriver("dup", "X");
		registerDriver(d1);
		registerDriver({ ...d1, name: "Renamed" });
		const ids = listDrivers().map((d) => d.id);
		expect(ids.filter((i) => i === "dup")).toHaveLength(1);
		expect(getDriver("dup")?.name).toBe("Renamed");
	});
});

describe("resolveActiveDriver", () => {
	beforeEach(() => {
		registerDriver(openrouterDriver);
		registerDriver(tensorzeroDriver);
		registerDriver(litellmDriver);
	});

	it("returns null when no env matches", () => {
		expect(resolveActiveDriver({})).toBeNull();
	});

	it("respects LLM_ROUTER_DRIVER override", () => {
		const d = resolveActiveDriver({ LLM_ROUTER_DRIVER: "litellm", LITELLM_HOST: "http://x" });
		expect(d?.id).toBe("litellm");
	});

	it("override is case-insensitive", () => {
		const d = resolveActiveDriver({ LLM_ROUTER_DRIVER: "OpenRouter", OPENROUTER_API_KEY: "k" });
		expect(d?.id).toBe("openrouter");
	});

	it("ignores override that doesn't match any registered driver", () => {
		const d = resolveActiveDriver({ LLM_ROUTER_DRIVER: "ghost", OPENROUTER_API_KEY: "k" });
		expect(d?.id).toBe("openrouter");
	});

	it("auto-detects openrouter via OPENROUTER_API_KEY", () => {
		expect(resolveActiveDriver({ OPENROUTER_API_KEY: "k" })?.id).toBe("openrouter");
	});

	it("auto-detects tensorzero via TENSORZERO_HOST", () => {
		expect(resolveActiveDriver({ TENSORZERO_HOST: "http://x" })?.id).toBe("tensorzero");
	});

	it("auto-detects litellm via LITELLM_HOST", () => {
		expect(resolveActiveDriver({ LITELLM_HOST: "http://x" })?.id).toBe("litellm");
	});
});

describe("openrouterDriver", () => {
	it("detect requires OPENROUTER_API_KEY", () => {
		expect(openrouterDriver.detect({})).toBe(false);
		expect(openrouterDriver.detect({ OPENROUTER_API_KEY: "k" })).toBe(true);
	});

	it("configFromEnv pulls api key, host fallback, site url", () => {
		const cfg = openrouterDriver.configFromEnv({
			OPENROUTER_API_KEY: "secret",
			SITE_URL: "https://example.com",
		});
		expect(cfg.apiKey).toBe("secret");
		expect(cfg.host).toBe("https://openrouter.ai/api/v1");
		expect(cfg.siteUrl).toBe("https://example.com");
	});

	it("respects OPENROUTER_HOST override", () => {
		expect(openrouterDriver.configFromEnv({ OPENROUTER_HOST: "http://local" }).host).toBe(
			"http://local",
		);
	});

	it("build throws without apiKey", () => {
		expect(() => openrouterDriver.build({})).toThrow(/apiKey missing/);
	});

	it("build returns handler set", () => {
		const h = openrouterDriver.build({ apiKey: "k" });
		expect(typeof h.chatCompletion).toBe("function");
		expect(typeof h.embeddings).toBe("function");
		expect(typeof h.listModels).toBe("function");
	});

	it("chatCompletion sends Bearer auth + JSON body to /chat/completions", async () => {
		const h = openrouterDriver.build({ apiKey: "k", siteUrl: "https://s" });
		let capturedUrl = "";
		let capturedInit: RequestInit | undefined;
		const fakeFetch = (async (url: any, init?: RequestInit) => {
			capturedUrl = String(url);
			capturedInit = init;
			return new Response(JSON.stringify({ id: "x" }), { status: 200 });
		}) as typeof fetch;
		const res = await h.chatCompletion(
			{ model: "m", messages: [{ role: "user", content: "hi" }] },
			fakeFetch,
		);
		expect(capturedUrl).toContain("/chat/completions");
		const headers = capturedInit?.headers as Record<string, string>;
		expect(headers.Authorization).toBe("Bearer k");
		expect(headers["HTTP-Referer"]).toBe("https://s");
		expect((res as any).id).toBe("x");
	});

	it("chatCompletion throws on non-ok", async () => {
		const h = openrouterDriver.build({ apiKey: "k" });
		const fakeFetch = (async () =>
			new Response("nope", { status: 500 })) as unknown as typeof fetch;
		await expect(
			h.chatCompletion({ model: "m", messages: [] }, fakeFetch),
		).rejects.toThrow(/OpenRouter chat 500/);
	});
});

describe("tensorzeroDriver", () => {
	it("detect requires TENSORZERO_HOST", () => {
		expect(tensorzeroDriver.detect({})).toBe(false);
		expect(tensorzeroDriver.detect({ TENSORZERO_HOST: "http://x" })).toBe(true);
	});

	it("build throws without host", () => {
		expect(() => tensorzeroDriver.build({})).toThrow();
	});
});

describe("litellmDriver", () => {
	it("detect requires LITELLM_HOST", () => {
		expect(litellmDriver.detect({})).toBe(false);
		expect(litellmDriver.detect({ LITELLM_HOST: "http://x" })).toBe(true);
	});

	it("build throws without host", () => {
		expect(() => litellmDriver.build({})).toThrow(/host missing/);
	});

	it("configFromEnv reads host + key", () => {
		const cfg = litellmDriver.configFromEnv({
			LITELLM_HOST: "http://h",
			LITELLM_API_KEY: "k",
		});
		expect(cfg.host).toBe("http://h");
		expect(cfg.apiKey).toBe("k");
	});
});
