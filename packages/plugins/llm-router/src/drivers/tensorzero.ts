/**
 * TensorZero driver — https://github.com/tensorzero/tensorzero
 *
 * OpenAI-compat endpoints at /openai/v1/chat/completions and
 * /openai/v1/embeddings. Native /inference (with function_name +
 * variant_name + episode_id) and /feedback for evals — exposed via
 * nativeRoutes.
 *
 * Self-hosted by default; auth optional.
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
		name: "inference",
		description:
			"TensorZero native inference. body: { function_name, variant_name?, episode_id?, input, params? }",
		method: "POST",
		handler: async (body, fetchImpl, _ctx) => {
			const host = process.env.TENSORZERO_HOST;
			if (!host) return { ok: false, error: "TENSORZERO_HOST not set" };
			const headers = authHeaders({
				apiKey: process.env.TENSORZERO_API_KEY,
			});
			const res = await fetchImpl(url(host, "/inference"), {
				method: "POST",
				headers,
				body: JSON.stringify(body),
			});
			if (!res.ok) {
				const text = await res.text().catch(() => "<unreadable>");
				return { ok: false, error: `TensorZero inference ${res.status}: ${text.slice(0, 300)}` };
			}
			return { ok: true, response: await res.json() };
		},
	},
	{
		name: "feedback",
		description:
			"TensorZero feedback (eval signals). body: { inference_id|episode_id, metric_name, value, tags?, dryrun? }",
		method: "POST",
		handler: async (body, fetchImpl, _ctx) => {
			const host = process.env.TENSORZERO_HOST;
			if (!host) return { ok: false, error: "TENSORZERO_HOST not set" };
			const headers = authHeaders({
				apiKey: process.env.TENSORZERO_API_KEY,
			});
			const res = await fetchImpl(url(host, "/feedback"), {
				method: "POST",
				headers,
				body: JSON.stringify(body),
			});
			if (!res.ok) {
				const text = await res.text().catch(() => "<unreadable>");
				return { ok: false, error: `TensorZero feedback ${res.status}: ${text.slice(0, 300)}` };
			}
			return { ok: true, response: await res.json() };
		},
	},
];

export const tensorzeroDriver: Driver = {
	id: "tensorzero",
	name: "TensorZero",

	defaults: {
		chatModel: "anthropic::claude-haiku-4-5",
		embeddingsModel: "openai::text-embedding-3-small",
	},

	configFromEnv(env) {
		return {
			host: env.TENSORZERO_HOST,
			apiKey: env.TENSORZERO_API_KEY,
			siteUrl: env.SITE_URL,
			siteName: undefined,
		};
	},

	detect(env) {
		return Boolean(env.TENSORZERO_HOST);
	},

	nativeRoutes,

	build(config) {
		if (!config.host) throw new Error("TensorZero: host missing");
		const base = config.host;
		const headers = authHeaders(config);

		return {
			async chatCompletion(input, fetchImpl) {
				const res = await fetchImpl(url(base, "/openai/v1/chat/completions"), {
					method: "POST",
					headers,
					body: JSON.stringify(input),
				});
				if (!res.ok) {
					const text = await res.text().catch(() => "<unreadable>");
					throw new Error(`TensorZero chat ${res.status}: ${text.slice(0, 300)}`);
				}
				return await res.json();
			},

			async embeddings(input, fetchImpl) {
				const res = await fetchImpl(url(base, "/openai/v1/embeddings"), {
					method: "POST",
					headers,
					body: JSON.stringify(input),
				});
				if (!res.ok) {
					const text = await res.text().catch(() => "<unreadable>");
					throw new Error(`TensorZero embeddings ${res.status}: ${text.slice(0, 300)}`);
				}
				return await res.json();
			},

			async listModels(fetchImpl) {
				const res = await fetchImpl(url(base, "/openai/v1/models"), { headers });
				if (!res.ok) throw new Error(`TensorZero models ${res.status}`);
				const json = (await res.json()) as { data?: Array<{ id: string }> };
				return json.data ?? [];
			},

			async pingHealth(fetchImpl) {
				try {
					const res = await fetchImpl(url(base, "/health"), { headers });
					return res.ok;
				} catch {
					return false;
				}
			},
		};
	},
};
