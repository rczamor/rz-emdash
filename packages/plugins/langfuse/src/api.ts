/**
 * Langfuse Public REST API helpers.
 *
 * Direct fetch wrappers — no SDK. Auth is HTTP Basic with
 * public_key:secret_key.
 */

import type { IngestionEvent, LangfuseDatasetItem, LangfusePrompt } from "./types.js";

export interface LangfuseConfig {
	host: string;
	publicKey: string;
	secretKey: string;
	fetchImpl?: typeof fetch;
}

function authHeader(config: LangfuseConfig): string {
	// btoa is not always available in Node — encode via Buffer when present.
	const raw = `${config.publicKey}:${config.secretKey}`;
	const encoded = typeof Buffer !== "undefined" ? Buffer.from(raw).toString("base64") : btoa(raw);
	return `Basic ${encoded}`;
}

function url(host: string, path: string): string {
	return host.replace(/\/$/, "") + path;
}

export async function ingest(events: IngestionEvent[], config: LangfuseConfig): Promise<void> {
	if (events.length === 0) return;
	const fetchImpl = config.fetchImpl ?? globalThis.fetch;
	const res = await fetchImpl(url(config.host, "/api/public/ingestion"), {
		method: "POST",
		headers: {
			Authorization: authHeader(config),
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ batch: events }),
	});
	if (!res.ok) {
		const text = await res.text().catch(() => "<unreadable>");
		throw new Error(`Langfuse ingest ${res.status}: ${text.slice(0, 200)}`);
	}
}

export async function getPrompt(
	name: string,
	options: { label?: string; version?: number },
	config: LangfuseConfig,
): Promise<LangfusePrompt | null> {
	const fetchImpl = config.fetchImpl ?? globalThis.fetch;
	const params = new URLSearchParams();
	if (options.label) params.set("label", options.label);
	if (options.version != null) params.set("version", String(options.version));
	const qs = params.toString();
	const res = await fetchImpl(
		url(config.host, `/api/public/v2/prompts/${encodeURIComponent(name)}${qs ? `?${qs}` : ""}`),
		{ headers: { Authorization: authHeader(config) } },
	);
	if (!res.ok) return null;
	return (await res.json()) as LangfusePrompt;
}

export async function listDatasetItems(
	datasetName: string,
	config: LangfuseConfig,
): Promise<LangfuseDatasetItem[]> {
	const fetchImpl = config.fetchImpl ?? globalThis.fetch;
	const res = await fetchImpl(
		url(config.host, `/api/public/datasets/${encodeURIComponent(datasetName)}/items?limit=200`),
		{ headers: { Authorization: authHeader(config) } },
	);
	if (!res.ok) return [];
	const json = (await res.json()) as { data?: LangfuseDatasetItem[] };
	return json.data ?? [];
}

export async function pingHealth(config: LangfuseConfig): Promise<boolean> {
	const fetchImpl = config.fetchImpl ?? globalThis.fetch;
	try {
		const res = await fetchImpl(url(config.host, "/api/public/health"), {
			headers: { Authorization: authHeader(config) },
		});
		return res.ok;
	} catch {
		return false;
	}
}
