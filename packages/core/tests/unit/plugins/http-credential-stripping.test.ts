/**
 * Tests that plugin HTTP functions strip credential headers on cross-origin redirects.
 *
 * Both createHttpAccess and createUnrestrictedHttpAccess manually follow redirects.
 * When a redirect crosses origins, Authorization/Cookie/Proxy-Authorization headers
 * must be stripped to prevent credential leakage to untrusted hosts.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { setDefaultDnsResolver } from "../../../src/import/ssrf.js";
import { createHttpAccess, createUnrestrictedHttpAccess } from "../../../src/plugins/context.js";

// Intercept globalThis.fetch so we can simulate redirect chains
const mockFetch = vi.fn<typeof globalThis.fetch>();
vi.stubGlobal("fetch", mockFetch);

// Bypass DoH so the fetch mock only sees the calls these tests model.
// Returns a fixed public IP so resolveAndValidateExternalUrl passes.
const STUB_RESOLVER = async () => ["93.184.216.34"];
let previousResolver: ReturnType<typeof setDefaultDnsResolver> | undefined;

beforeAll(() => {
	previousResolver = setDefaultDnsResolver(STUB_RESOLVER);
});

afterAll(() => {
	setDefaultDnsResolver(previousResolver ?? null);
});

afterEach(() => {
	mockFetch.mockReset();
});

/** Build a minimal redirect response */
function redirectResponse(location: string, status = 302): Response {
	return new Response(null, {
		status,
		headers: { Location: location },
	});
}

/** Build a 200 response */
function okResponse(body = "ok"): Response {
	return new Response(body, { status: 200 });
}

/** Extract the headers passed to the Nth fetch call */
function headersOfCall(callIndex: number): Headers {
	const init = mockFetch.mock.calls[callIndex]?.[1] as RequestInit | undefined;
	return new Headers(init?.headers);
}

// =============================================================================
// createHttpAccess – host-restricted
// =============================================================================

describe("createHttpAccess host allowlist matching", () => {
	const pluginId = "test-plugin";

	it('allows any hostname when allowedHosts contains standalone "*"', async () => {
		mockFetch.mockResolvedValue(okResponse());

		const http = createHttpAccess(pluginId, ["*"]);
		await expect(http.fetch("https://api.example.com/v1")).resolves.toBeInstanceOf(Response);
		await expect(http.fetch("https://random.host.io/path")).resolves.toBeInstanceOf(Response);
	});

	it('allows requests when "*" is mixed with explicit hosts', async () => {
		mockFetch.mockResolvedValue(okResponse());

		const http = createHttpAccess(pluginId, ["*", "api.example.com"]);
		await expect(http.fetch("https://another.example.net/ok")).resolves.toBeInstanceOf(Response);
	});

	it('still supports "*.domain" wildcard matching', async () => {
		mockFetch.mockResolvedValue(okResponse());

		const http = createHttpAccess(pluginId, ["*.example.com"]);
		await expect(http.fetch("https://api.example.com/v1")).resolves.toBeInstanceOf(Response);
		await expect(http.fetch("https://evil.com")).rejects.toThrow(
			'is not allowed to fetch from host "evil.com"',
		);
	});
});

describe("createHttpAccess credential stripping", () => {
	const pluginId = "test-plugin";
	const allowedHosts = ["a.example.com", "b.example.com"];

	it("preserves credentials on same-origin redirect", async () => {
		mockFetch
			.mockResolvedValueOnce(redirectResponse("https://a.example.com/page2"))
			.mockResolvedValueOnce(okResponse());

		const http = createHttpAccess(pluginId, allowedHosts);
		await http.fetch("https://a.example.com/page1", {
			headers: { Authorization: "Bearer secret", Cookie: "session=abc" },
		});

		// Second call should still have credentials (same origin)
		const h = headersOfCall(1);
		expect(h.get("authorization")).toBe("Bearer secret");
		expect(h.get("cookie")).toBe("session=abc");
	});

	it("strips credentials on cross-origin redirect", async () => {
		mockFetch
			.mockResolvedValueOnce(redirectResponse("https://b.example.com/landing"))
			.mockResolvedValueOnce(okResponse());

		const http = createHttpAccess(pluginId, allowedHosts);
		await http.fetch("https://a.example.com/start", {
			headers: {
				Authorization: "Bearer secret",
				Cookie: "session=abc",
				"Proxy-Authorization": "Basic creds",
				"X-Custom": "keep-me",
			},
		});

		const h = headersOfCall(1);
		expect(h.get("authorization")).toBeNull();
		expect(h.get("cookie")).toBeNull();
		expect(h.get("proxy-authorization")).toBeNull();
		// Non-credential headers survive
		expect(h.get("x-custom")).toBe("keep-me");
	});

	it("strips credentials only once even with multiple same-origin hops after cross-origin", async () => {
		// a.example.com -> b.example.com -> b.example.com/final
		mockFetch
			.mockResolvedValueOnce(redirectResponse("https://b.example.com/step1"))
			.mockResolvedValueOnce(redirectResponse("https://b.example.com/step2"))
			.mockResolvedValueOnce(okResponse());

		const http = createHttpAccess(pluginId, allowedHosts);
		await http.fetch("https://a.example.com/start", {
			headers: { Authorization: "Bearer secret" },
		});

		// Call 0: original (has auth)
		expect(headersOfCall(0).get("authorization")).toBe("Bearer secret");
		// Call 1: after cross-origin hop (stripped)
		expect(headersOfCall(1).get("authorization")).toBeNull();
		// Call 2: same-origin hop on b (still stripped -- not re-added)
		expect(headersOfCall(2).get("authorization")).toBeNull();
	});

	it("does not mint internal plugin auth after an external redirect into the plugin API", async () => {
		mockFetch
			.mockResolvedValueOnce(
				redirectResponse("https://cms.example.test/_emdash/api/plugins/agents/private"),
			)
			.mockResolvedValueOnce(okResponse());

		const http = createHttpAccess("tools", ["a.example.com"], "https://cms.example.test");
		await http.fetch("https://a.example.com/start");

		const h = headersOfCall(1);
		expect(h.get("x-emdash-internal-plugin")).toBeNull();
		expect(h.get("x-emdash-internal-plugin-from")).toBeNull();
		expect(h.get("x-emdash-request")).toBeNull();
	});

	it("forwards X-EmDash-Run-Id and X-EmDash-Trace-Id on internal plugin RPC", async () => {
		mockFetch.mockResolvedValueOnce(okResponse());

		const http = createHttpAccess("tools", [], "https://cms.example.test", {
			runId: "run_abc",
			traceId: "trace_xyz",
		});
		await http.fetch("https://cms.example.test/_emdash/api/plugins/agents/agents.get");

		const h = headersOfCall(0);
		expect(h.get("x-emdash-run-id")).toBe("run_abc");
		expect(h.get("x-emdash-trace-id")).toBe("trace_xyz");
		expect(h.get("x-emdash-internal-plugin-from")).toBe("tools");
	});

	it("does not forward run/trace headers to external destinations", async () => {
		mockFetch.mockResolvedValueOnce(okResponse());

		const http = createHttpAccess("tools", ["api.example.com"], "https://cms.example.test", {
			runId: "run_abc",
			traceId: "trace_xyz",
		});
		await http.fetch("https://api.example.com/external");

		const h = headersOfCall(0);
		expect(h.get("x-emdash-run-id")).toBeNull();
		expect(h.get("x-emdash-trace-id")).toBeNull();
		expect(h.get("x-emdash-internal-plugin")).toBeNull();
	});

	it("omits run/trace headers when not provided", async () => {
		mockFetch.mockResolvedValueOnce(okResponse());

		const http = createHttpAccess("tools", [], "https://cms.example.test");
		await http.fetch("https://cms.example.test/_emdash/api/plugins/agents/agents.get");

		const h = headersOfCall(0);
		expect(h.get("x-emdash-run-id")).toBeNull();
		expect(h.get("x-emdash-trace-id")).toBeNull();
		expect(h.get("x-emdash-internal-plugin-from")).toBe("tools");
	});
});

// =============================================================================
// createUnrestrictedHttpAccess – SSRF-protected but no host list
// =============================================================================

describe("createUnrestrictedHttpAccess credential stripping", () => {
	const pluginId = "unrestricted-plugin";

	it("preserves credentials on same-origin redirect", async () => {
		mockFetch
			.mockResolvedValueOnce(redirectResponse("https://api.example.com/v2"))
			.mockResolvedValueOnce(okResponse());

		const http = createUnrestrictedHttpAccess(pluginId);
		await http.fetch("https://api.example.com/v1", {
			headers: { Authorization: "Bearer token" },
		});

		expect(headersOfCall(1).get("authorization")).toBe("Bearer token");
	});

	it("strips credentials on cross-origin redirect", async () => {
		mockFetch
			.mockResolvedValueOnce(redirectResponse("https://evil.example.com/steal"))
			.mockResolvedValueOnce(okResponse());

		const http = createUnrestrictedHttpAccess(pluginId);
		await http.fetch("https://api.example.com/start", {
			headers: {
				Authorization: "Bearer token",
				Cookie: "session=xyz",
				"Proxy-Authorization": "Basic pw",
				Accept: "application/json",
			},
		});

		const h = headersOfCall(1);
		expect(h.get("authorization")).toBeNull();
		expect(h.get("cookie")).toBeNull();
		expect(h.get("proxy-authorization")).toBeNull();
		expect(h.get("accept")).toBe("application/json");
	});

	it("handles redirect with no init gracefully", async () => {
		mockFetch
			.mockResolvedValueOnce(redirectResponse("https://other.example.com/"))
			.mockResolvedValueOnce(okResponse());

		const http = createUnrestrictedHttpAccess(pluginId);
		// No init at all -- should not throw
		await http.fetch("https://api.example.com/bare");

		expect(headersOfCall(1).get("authorization")).toBeNull();
	});
});
