/**
 * Langfuse Plugin for EmDash CMS.
 *
 * Sends agent traces, generations, and scores to a Langfuse instance
 * (self-hosted or cloud). Fetches versioned prompts. Runs eval
 * datasets through registered agents.
 *
 * Configuration via env vars (preferred for keys):
 *
 *   LANGFUSE_HOST          — e.g. "https://cloud.langfuse.com" or
 *                            "http://langfuse-web:3000" for the
 *                            VPS-hosted instance
 *   LANGFUSE_PUBLIC_KEY    — pk-lf-...
 *   LANGFUSE_SECRET_KEY    — sk-lf-...
 *
 * Or POST /langfuse/settings.setKeys to store in plugin KV.
 *
 * Why no SDK? The Langfuse JS SDK is fine but adds a few hundred KB
 * and bundles its own fetch shim. The Public REST API is small and
 * stable — direct calls keep the dep tree clean and the integration
 * easy to read. If you need batched-ingestion auto-flush, swap to
 * the SDK; for our current scale (<100 calls/min per plugin) direct
 * calls with `await` are fine.
 *
 * Auto-tracing of OpenRouter calls is NOT yet wired in v1 — the
 * OpenRouter plugin would need to call back into this plugin after
 * each chat completion. For now, traces are manual via the
 * `langfuse:trace` automation action or direct API calls. Auto-trace
 * is Phase 3.
 */

import type { PluginDescriptor } from "emdash";

export type {
	GenerationCreateBody,
	IngestionEvent,
	LangfuseDatasetItem,
	LangfusePrompt,
	ScoreCreateBody,
	TraceCreateBody,
} from "./types.js";

export function langfusePlugin(): PluginDescriptor {
	return {
		id: "langfuse",
		version: "0.0.1",
		format: "standard",
		entrypoint: "@emdash-cms/plugin-langfuse/sandbox",
		options: {},
		capabilities: ["network:fetch"],
		// allowedHosts is broad because Langfuse can be self-hosted at
		// any internal address. Lock down at install time if needed.
		allowedHosts: ["*"],
		storage: {
			recent_traces: { indexes: ["createdAt", "task_id", "agent_id"] },
		},
		adminPages: [{ path: "/langfuse", label: "Langfuse", icon: "chart-line" }],
		adminWidgets: [{ id: "langfuse-recent", title: "Recent traces", size: "half" }],
	};
}
