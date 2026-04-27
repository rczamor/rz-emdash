/**
 * Driver contract — what an LLM gateway driver must implement.
 *
 * The router selects an active driver at startup (env-var driven)
 * and routes every chat / embeddings / models call through it.
 * Drivers can optionally expose `nativeRoutes` for provider-specific
 * surfaces (TensorZero's /inference, LiteLLM's /spend, etc.) — these
 * are mounted at `/_emdash/api/plugins/llm-router/native/<driverId>/<route>`.
 *
 * Drivers are pure: they accept a config blob and return resolved
 * fetch wrappers. The router owns the chat-loop, event emission,
 * cost recording, agent context — all the cross-cutting concerns.
 */

import type { PluginContext } from "emdash";

import type {
	ChatCompletionInput,
	ChatCompletionResponse,
	EmbeddingsInput,
	EmbeddingsResponse,
	ModelInfo,
} from "./types.js";

export interface DriverConfig {
	/** Base URL of the gateway. */
	host?: string;
	/** Bearer token, optional for some self-hosted setups. */
	apiKey?: string;
	/** Where the agent is running, for analytics / referer headers. */
	siteUrl?: string;
	siteName?: string;
}

export type DriverFetchImpl = typeof fetch;

export interface DriverHandlers {
	chatCompletion: (
		input: ChatCompletionInput,
		fetchImpl: DriverFetchImpl,
	) => Promise<ChatCompletionResponse>;
	embeddings: (input: EmbeddingsInput, fetchImpl: DriverFetchImpl) => Promise<EmbeddingsResponse>;
	listModels: (fetchImpl: DriverFetchImpl) => Promise<ModelInfo[]>;
	pingHealth?: (fetchImpl: DriverFetchImpl) => Promise<boolean>;
}

/**
 * A native route the driver wants to expose under the router's namespace.
 * The router calls this handler with the request body and the live
 * plugin context — same shape as a regular plugin route handler so the
 * driver author doesn't have to learn a new abstraction.
 */
export interface NativeRoute {
	name: string;
	description?: string;
	method?: "GET" | "POST";
	handler: (body: unknown, fetchImpl: DriverFetchImpl, ctx: PluginContext) => Promise<unknown>;
}

export interface Driver {
	/** Lowercase driver id, e.g. "openrouter" / "tensorzero" / "litellm". */
	id: string;
	/** Human-readable name. */
	name: string;
	/**
	 * Build runtime handlers from the resolved config. Throws if
	 * required config is missing.
	 */
	build(config: DriverConfig): DriverHandlers;
	/**
	 * Detect whether this driver should auto-activate based on the
	 * current process environment. The router calls this on each
	 * registered driver in registration order; the first one that
	 * returns true wins. Override with the LLM_ROUTER_DRIVER env var
	 * to skip detection.
	 */
	detect(env: Record<string, string | undefined>): boolean;
	/** Return the resolved DriverConfig from environment + KV. */
	configFromEnv(env: Record<string, string | undefined>): DriverConfig;
	/** Provider-specific routes, mounted under the router's namespace. */
	nativeRoutes?: NativeRoute[];
	/** Sensible default model ids if user hasn't picked one. */
	defaults?: { chatModel?: string; embeddingsModel?: string };
}

const drivers = new Map<string, Driver>();
const order: string[] = [];

export function registerDriver(driver: Driver): void {
	if (!drivers.has(driver.id)) order.push(driver.id);
	drivers.set(driver.id, driver);
}

/** @internal — test hook for clearing the registry between cases. */
export function _resetDrivers(): void {
	drivers.clear();
	order.length = 0;
}

export function getDriver(id: string): Driver | undefined {
	return drivers.get(id);
}

export function listDrivers(): Driver[] {
	return order.map((id) => drivers.get(id)!).filter(Boolean);
}

/**
 * Resolve which driver should be active. Priority:
 *   1. LLM_ROUTER_DRIVER env var (explicit override)
 *   2. First driver whose detect() returns true (registration order)
 *   3. null (no driver active)
 */
export function resolveActiveDriver(env: Record<string, string | undefined>): Driver | null {
	const override = env.LLM_ROUTER_DRIVER?.toLowerCase();
	if (override) {
		const d = drivers.get(override);
		if (d) return d;
	}
	for (const id of order) {
		const d = drivers.get(id)!;
		try {
			if (d.detect(env)) return d;
		} catch {
			/* skip */
		}
	}
	return null;
}
