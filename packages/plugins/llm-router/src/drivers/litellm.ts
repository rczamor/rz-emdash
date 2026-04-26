/**
 * LiteLLM driver — https://docs.litellm.ai/
 *
 * Self-hosted LLM proxy with unified OpenAI-compat surface across
 * 100+ providers. Native endpoints for spend tracking + key
 * management exposed via nativeRoutes.
 */

import type { Driver, NativeRoute } from "../driver.js";

function authHeaders(config: { apiKey?: string; siteUrl?: string; siteName?: string }): Record<string, string> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
	if (config.siteUrl) headers["HTTP-Referer"] = config.siteUrl;
	if (config.siteName) headers["X-Title"] = config.siteName;
	return headers;
}

function url(base: string, path: string): string {
	return base.replace(/\/$/, "") + path;
}

const nativeRoutes: NativeRoute[] = [
	{
		name: "spend.logs",
		description:
			"LiteLLM spend logs. body: { request_id?, api_key?, user_id?, start_date?, end_date? }",
		method: "POST",
		handler: async (body, fetchImpl, _ctx) => {
			const host = process.env.LITELLM_HOST;
			if (!host) return { ok: false, error: "LITELLM_HOST not set" };
			const headers = authHeaders({ apiKey: process.env.LITELLM_API_KEY });
			const res = await fetchImpl(url(host, "/spend/logs"), {
				method: "GET",
				headers,
			});
			if (!res.ok) {
				return { ok: false, error: `LiteLLM spend.logs ${res.status}` };
			}
			return { ok: true, response: await res.json() };
		},
	},
	{
		name: "key.info",
		description: "LiteLLM key info — health + usage of the configured API key.",
		method: "GET",
		handler: async (_body, fetchImpl, _ctx) => {
			const host = process.env.LITELLM_HOST;
			if (!host) return { ok: false, error: "LITELLM_HOST not set" };
			const headers = authHeaders({ apiKey: process.env.LITELLM_API_KEY });
			const res = await fetchImpl(url(host, "/key/info"), {
				method: "GET",
				headers,
			});
			if (!res.ok) return { ok: false, error: `LiteLLM key.info ${res.status}` };
			return { ok: true, response: await res.json() };
		},
	},
];

export const litellmDriver: Driver = {
	id: "litellm",
	name: "LiteLLM",

	defaults: {
		chatModel: "claude-3-5-haiku-latest",
		embeddingsModel: "text-embedding-3-small",
	},

	configFromEnv(env) {
		return {
			host: env.LITELLM_HOST,
			apiKey: env.LITELLM_API_KEY,
			siteUrl: env.SITE_URL,
			siteName: undefined,
		};
	},

	detect(env) {
		return Boolean(env.LITELLM_HOST);
	},

	nativeRoutes,

	build(config) {
		if (!config.host) throw new Error("LiteLLM: host missing");
		const base = config.host;
		const headers = authHeaders(config);

		return {
			async chatCompletion(input, fetchImpl) {
				const res = await fetchImpl(url(base, "/chat/completions"), {
					method: "POST",
					headers,
					body: JSON.stringify(input),
				});
				if (!res.ok) {
					const text = await res.text().catch(() => "<unreadable>");
					throw new Error(`LiteLLM chat ${res.status}: ${text.slice(0, 300)}`);
				}
				return await res.json();
			},

			async embeddings(input, fetchImpl) {
				const res = await fetchImpl(url(base, "/embeddings"), {
					method: "POST",
					headers,
					body: JSON.stringify(input),
				});
				if (!res.ok) {
					const text = await res.text().catch(() => "<unreadable>");
					throw new Error(`LiteLLM embeddings ${res.status}: ${text.slice(0, 300)}`);
				}
				return await res.json();
			},

			async listModels(fetchImpl) {
				const res = await fetchImpl(url(base, "/v1/models"), { headers });
				if (!res.ok) {
					// Some LiteLLM setups expose at /models without the v1 prefix.
					const fallback = await fetchImpl(url(base, "/models"), { headers });
					if (!fallback.ok) throw new Error(`LiteLLM models ${res.status}`);
					const json = (await fallback.json()) as { data?: Array<{ id: string }> };
					return json.data ?? [];
				}
				const json = (await res.json()) as { data?: Array<{ id: string }> };
				return json.data ?? [];
			},

			async pingHealth(fetchImpl) {
				try {
					const res = await fetchImpl(url(base, "/health/liveliness"), { headers });
					return res.ok;
				} catch {
					return false;
				}
			},
		};
	},
};
