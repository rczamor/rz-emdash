/**
 * OpenRouter driver — https://openrouter.ai
 *
 * OpenAI-compatible at /api/v1/chat/completions, /embeddings, /models.
 * Auth: Bearer key.
 */

import type { Driver } from "../driver.js";

const TRAILING_SLASH_RE = /\/$/;

const DEFAULT_BASE = "https://openrouter.ai/api/v1";

function authHeaders(config: {
	apiKey?: string;
	siteUrl?: string;
	siteName?: string;
}): Record<string, string> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
	if (config.siteUrl) headers["HTTP-Referer"] = config.siteUrl;
	if (config.siteName) headers["X-Title"] = config.siteName;
	return headers;
}

function url(base: string, path: string): string {
	return base.replace(TRAILING_SLASH_RE, "") + path;
}

export const openrouterDriver: Driver = {
	id: "openrouter",
	name: "OpenRouter",

	defaults: {
		chatModel: "anthropic/claude-haiku-4-5",
		embeddingsModel: "openai/text-embedding-3-small",
	},

	configFromEnv(env) {
		return {
			host: env.OPENROUTER_HOST ?? DEFAULT_BASE,
			apiKey: env.OPENROUTER_API_KEY,
			siteUrl: env.SITE_URL,
			siteName: undefined,
		};
	},

	detect(env) {
		return Boolean(env.OPENROUTER_API_KEY);
	},

	build(config) {
		if (!config.apiKey) throw new Error("OpenRouter: apiKey missing");
		const base = config.host ?? DEFAULT_BASE;
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
					throw new Error(`OpenRouter chat ${res.status}: ${text.slice(0, 300)}`);
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
					throw new Error(`OpenRouter embeddings ${res.status}: ${text.slice(0, 300)}`);
				}
				return await res.json();
			},

			async listModels(fetchImpl) {
				const res = await fetchImpl(url(base, "/models"), { headers });
				if (!res.ok) throw new Error(`OpenRouter models ${res.status}`);
				const json = (await res.json()) as { data?: Array<{ id: string }> };
				return json.data ?? [];
			},

			async pingHealth(fetchImpl) {
				try {
					const res = await fetchImpl(url(base, "/models"), { headers });
					return res.ok;
				} catch {
					return false;
				}
			},
		};
	},
};
