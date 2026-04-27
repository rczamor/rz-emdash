import { describe, expect, it, vi } from "vitest";

import { getString, isRecord, sendWebhook, validateWebhookUrl } from "../src/pure.js";

describe("validateWebhookUrl — SSRF protection", () => {
	it.each([
		["public https", "https://example.com/hook"],
		["public http with port", "http://example.com:8080/hook"],
	])("accepts: %s", (_, url) => {
		expect(() => validateWebhookUrl(url)).not.toThrow();
	});

	it.each([
		["malformed", "not a url", /Invalid webhook URL/],
		["ftp scheme", "ftp://example.com", /scheme.*not allowed/],
		["file scheme", "file:///etc/passwd", /scheme.*not allowed/],
		["javascript scheme", "javascript:alert(1)", /scheme.*not allowed/],
		["localhost hostname", "http://localhost/hook", /internal hosts/],
		["127.0.0.1 loopback", "http://127.0.0.1/hook", /private IP/],
		["10.x.x.x range", "http://10.0.0.1/hook", /private IP/],
		["172.16-31 range", "http://172.16.0.1/hook", /private IP/],
		["192.168.x range", "http://192.168.1.1/hook", /private IP/],
		["169.254 link-local", "http://169.254.169.254/hook", /private IP/],
		["GCP metadata", "http://metadata.google.internal/", /internal hosts/],
		["IPv6 loopback ::1", "http://[::1]/hook", /internal addresses/],
		["IPv6 link-local fe80", "http://[fe80::1]/hook", /internal addresses/],
		["IPv6 ULA fc/fd prefix", "http://[fc00::1]/hook", /internal addresses/],
	])("rejects: %s", (_, url, match) => {
		expect(() => validateWebhookUrl(url)).toThrow(match);
	});

	it("hostname matching is case-insensitive", () => {
		expect(() => validateWebhookUrl("http://LOCALHOST/hook")).toThrow(/internal hosts/);
	});
});

const silentLog = {
	info: () => {},
	warn: () => {},
	error: () => {},
	debug: () => {},
};

const payload = {
	event: "content.created",
	timestamp: "2026-01-01T00:00:00Z",
	resourceId: "post:1",
	resourceType: "content" as const,
};

describe("sendWebhook", () => {
	it("succeeds on first attempt", async () => {
		const fetchFn = vi.fn(async () => new Response(null, { status: 200 }));
		const result = await sendWebhook(
			fetchFn,
			silentLog,
			"https://example.com/h",
			payload,
			undefined,
			3,
		);
		expect(result.success).toBe(true);
		expect(result.status).toBe(200);
		expect(fetchFn).toHaveBeenCalledTimes(1);
	});

	it("attaches Bearer token when provided", async () => {
		const fetchFn = vi.fn(async () => new Response(null, { status: 200 }));
		await sendWebhook(fetchFn, silentLog, "https://example.com/h", payload, "secret", 1);
		const init = fetchFn.mock.calls[0]?.[1] as RequestInit;
		const headers = init.headers as Record<string, string>;
		expect(headers.Authorization).toBe("Bearer secret");
		expect(headers["X-EmDash-Event"]).toBe("content.created");
		expect(headers["Content-Type"]).toBe("application/json");
	});

	it("serializes payload as JSON body", async () => {
		const fetchFn = vi.fn(async () => new Response(null, { status: 200 }));
		await sendWebhook(fetchFn, silentLog, "https://example.com/h", payload, undefined, 1);
		const init = fetchFn.mock.calls[0]?.[1] as RequestInit;
		expect(JSON.parse(init.body as string)).toEqual(payload);
	});

	it("retries on non-2xx and succeeds on later attempt", async () => {
		const fetchFn = vi
			.fn()
			.mockResolvedValueOnce(new Response("oops", { status: 503 }))
			.mockResolvedValueOnce(new Response(null, { status: 200 }));
		const result = await sendWebhook(
			fetchFn,
			silentLog,
			"https://example.com/h",
			payload,
			undefined,
			3,
		);
		expect(result.success).toBe(true);
		expect(fetchFn).toHaveBeenCalledTimes(2);
	}, 10000);

	it("retries on thrown errors and gives up after max attempts", async () => {
		const fetchFn = vi.fn(async () => {
			throw new Error("network down");
		});
		const result = await sendWebhook(
			fetchFn,
			silentLog,
			"https://example.com/h",
			payload,
			undefined,
			2,
		);
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/network down/);
		expect(fetchFn).toHaveBeenCalledTimes(2);
	}, 10000);

	it("propagates SSRF rejection before any fetch", async () => {
		const fetchFn = vi.fn();
		await expect(
			sendWebhook(fetchFn, silentLog, "http://localhost/", payload, undefined, 3),
		).rejects.toThrow(/internal hosts/);
		expect(fetchFn).not.toHaveBeenCalled();
	});
});

describe("isRecord / getString", () => {
	it.each([
		[{ a: 1 }, true],
		[null, false],
		[[], false],
		["s", false],
	])("isRecord(%j) → %s", (value, expected) => {
		expect(isRecord(value)).toBe(expected);
	});

	it("getString returns string when present", () => {
		expect(getString({ k: "v" }, "k")).toBe("v");
	});

	it("getString returns undefined for non-string", () => {
		expect(getString({ k: 42 }, "k")).toBeUndefined();
	});

	it("getString returns undefined when source isn't a record", () => {
		expect(getString(null, "k")).toBeUndefined();
		expect(getString([], "k")).toBeUndefined();
	});
});
