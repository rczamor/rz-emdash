/**
 * LLM Router Plugin for EmDash CMS — unified LLM gateway with
 * pluggable drivers.
 *
 * One plugin, three built-in drivers (OpenRouter, TensorZero, LiteLLM),
 * one set of `llm:*` automation actions, one chat-loop, one admin
 * page. Native provider-specific routes (TensorZero's /inference and
 * /feedback, LiteLLM's /spend/*) are mounted under
 * `/_emdash/api/plugins/llm-router/native/<driver>/<route>`.
 *
 * Driver selection priority:
 *   1. LLM_ROUTER_DRIVER env var (explicit override)
 *   2. First driver whose detect() returns true (registration order:
 *      tensorzero, openrouter, litellm)
 *   3. None — actions throw "no driver configured"
 *
 * Adding a new driver:
 *   1. Implement the Driver contract from
 *      `@emdash-cms/plugin-llm-router/driver`.
 *   2. Either ship as a separate npm package and call
 *      `registerDriver()` from your sandbox-entry, or add it to the
 *      built-in drivers/ directory and re-export.
 */

import type { PluginDescriptor } from "emdash";

export type {
	ChatCompletionInput,
	ChatCompletionResponse,
	ChatMessage,
	EmbeddingsInput,
	EmbeddingsResponse,
	ModelInfo,
	ToolSpec,
} from "./types.js";

export type { Driver, DriverConfig, DriverHandlers, NativeRoute } from "./driver.js";
export {
	getDriver,
	listDrivers,
	registerDriver,
	resolveActiveDriver,
} from "./driver.js";

export interface LlmRouterPluginOptions {
	/**
	 * Force a specific driver id. Overrides auto-detect and the
	 * LLM_ROUTER_DRIVER env var.
	 */
	driver?: "openrouter" | "tensorzero" | "litellm" | string;
}

export function llmRouterPlugin(_options: LlmRouterPluginOptions = {}): PluginDescriptor {
	return {
		id: "llm-router",
		version: "0.0.1",
		format: "standard",
		entrypoint: "@emdash-cms/plugin-llm-router/sandbox",
		options: {},
		capabilities: ["network:fetch"],
		// Drivers can target any host — keep allowlist permissive.
		allowedHosts: ["*"],
		storage: {
			usage: { indexes: ["createdAt", "model", "driver"] },
		},
		adminPages: [{ path: "/llm-router", label: "LLM Router", icon: "lightning" }],
		adminWidgets: [{ id: "llm-router-usage", title: "LLM usage (24h)", size: "half" }],
	};
}
