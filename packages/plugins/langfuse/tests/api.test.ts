import { describe, expect, it } from "vitest";

import { authHeader, url } from "../src/api.js";

describe("authHeader", () => {
	it("emits Basic + base64(public:secret)", () => {
		const out = authHeader({ host: "h", publicKey: "pk", secretKey: "sk" });
		expect(out).toBe(`Basic ${Buffer.from("pk:sk").toString("base64")}`);
	});

	it("preserves the colon delimiter", () => {
		const out = authHeader({ host: "h", publicKey: "abc", secretKey: "xyz" });
		const decoded = Buffer.from(out.replace(/^Basic /, ""), "base64").toString();
		expect(decoded).toBe("abc:xyz");
	});

	it("handles empty keys without throwing", () => {
		expect(authHeader({ host: "h", publicKey: "", secretKey: "" })).toBe("Basic Og==");
	});
});

describe("url", () => {
	it.each([
		[
			"host without trailing slash",
			"https://api.langfuse.com",
			"/api/v1/x",
			"https://api.langfuse.com/api/v1/x",
		],
		[
			"host with trailing slash",
			"https://api.langfuse.com/",
			"/api/v1/x",
			"https://api.langfuse.com/api/v1/x",
		],
		["empty path", "https://x.com", "", "https://x.com"],
		[
			"self-hosted localhost",
			"http://localhost:3000",
			"/api/public/ingestion",
			"http://localhost:3000/api/public/ingestion",
		],
	])("%s", (_, host, path, expected) => {
		expect(url(host, path)).toBe(expected);
	});
});
