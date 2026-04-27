const TRAILING_SLASH_RE = /\/$/;
/**
 * Tasks client utilities — pure functions importable by other plugins.
 *
 * Used today by the OpenRouter plugin to attribute LLM calls to tasks
 * and to enforce per-task / per-day-per-actor quotas before calling
 * the model.
 *
 * The functions need a PluginContext to read/write storage. We don't
 * import the runtime tasks plugin's storage handle directly — each
 * caller plugin has its own ctx with access to its own storage.
 * However, because these helpers operate on `_emdash:plugin-storage:
 * tasks` rows, callers must arrange for the helpers to receive a ctx
 * that *can read those rows*. In trusted mode that means the same
 * process; in sandboxed mode this would need an HTTP shim. For
 * Phase 1 (trusted), we expose helpers callers invoke from their own
 * sandbox-entry by using `ctx.storage.tasks` if their plugin
 * declared `tasks` in its descriptor `storage`. That's awkward.
 *
 * Cleaner pattern: callers POST to the tasks plugin's HTTP routes
 * (`tasks.cost`, `tasks.checkQuota`) which run in the tasks plugin's
 * own ctx. The functions here are thin fetch wrappers over those
 * routes, so the integration is the same in trusted and sandbox
 * modes.
 */

export interface RecordCostBody {
	id: string;
	model: string;
	tokensIn: number;
	tokensOut: number;
	usd?: number;
	source?: string;
	actor?: string;
}

export interface QuotaCheckBody {
	taskId?: string;
	actor: string;
	estimatedTokensIn?: number;
	estimatedTokensOut?: number;
}

export interface QuotaCheckResult {
	ok: boolean;
	dailyTokensUsed?: number;
	dailyTokensLimit?: number;
	taskTokensUsed?: number;
	taskTokensLimit?: number;
	reason?: string;
}

const BASE = "/_emdash/api/plugins/tasks";

export async function recordCost(
	body: RecordCostBody,
	options: { fetch?: typeof fetch; baseUrl?: string } = {},
): Promise<void> {
	const fetchImpl = options.fetch ?? globalThis.fetch;
	const url = (options.baseUrl ?? "").replace(TRAILING_SLASH_RE, "") + `${BASE}/cost.record`;
	const res = await fetchImpl(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		throw new Error(`tasks.cost.record failed: ${res.status}`);
	}
}

export async function checkQuota(
	body: QuotaCheckBody,
	options: { fetch?: typeof fetch; baseUrl?: string } = {},
): Promise<QuotaCheckResult> {
	const fetchImpl = options.fetch ?? globalThis.fetch;
	const url = (options.baseUrl ?? "").replace(TRAILING_SLASH_RE, "") + `${BASE}/quota.check`;
	const res = await fetchImpl(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!res.ok) return { ok: false, reason: `quota.check failed: ${res.status}` };
	const json = (await res.json()) as { data?: QuotaCheckResult };
	return json.data ?? { ok: false, reason: "Empty response" };
}
