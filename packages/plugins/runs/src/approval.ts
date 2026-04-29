/**
 * Approval gate evaluator.
 *
 * Decides whether a tool call needs human approval before execution.
 * The decision is independent of the tool's own internal gating —
 * tools that return `paused_for_human` already do their own gate;
 * this function lets the run config override (e.g., raise the cost
 * threshold for a trusted agent, add `web_fetch` to the always-gate
 * list).
 *
 * Default rules:
 *   - content_publish, content_delete, media_delete   → always gate
 *   - content_update of a published item              → gated by tool
 *   - any tool when projected step cost exceeds the
 *     run's `max_usd_unattended` (default $1.00)      → gate
 */

const DEFAULT_ALWAYS_GATE = new Set(["content_publish", "content_delete", "media_delete"]);

export interface RunGateConfig {
	/** Tools always gated regardless of run state. Merged with the defaults. */
	always_gate?: string[];
	/** Tools never gated (overrides defaults). Use with care. */
	never_gate?: string[];
	/**
	 * Spend threshold for unattended execution. If the projected next-step
	 * cost would push `cost.usd` above this, the tool pauses for
	 * approval. Default $1.00.
	 */
	max_usd_unattended?: number;
}

export interface GateInputs {
	tool: string;
	estimated_step_cost_usd?: number;
	current_cost_usd: number;
	config?: RunGateConfig;
}

export function shouldGate(inputs: GateInputs): { gate: boolean; reason?: string } {
	const config = inputs.config ?? {};
	const neverGate = new Set(config.never_gate ?? []);
	if (neverGate.has(inputs.tool)) return { gate: false };

	const alwaysGate = new Set([...DEFAULT_ALWAYS_GATE, ...(config.always_gate ?? [])]);
	if (alwaysGate.has(inputs.tool)) {
		return { gate: true, reason: `${inputs.tool} is always gated by policy` };
	}

	const threshold = config.max_usd_unattended ?? 1.0;
	const projected = inputs.current_cost_usd + (inputs.estimated_step_cost_usd ?? 0);
	if (projected > threshold) {
		return {
			gate: true,
			reason: `Projected cost $${projected.toFixed(4)} exceeds unattended threshold $${threshold.toFixed(2)}`,
		};
	}

	return { gate: false };
}

/** Generate a single-use approval token. Stored on the run; cleared on consume. */
export function newApprovalToken(): string {
	return `apr_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
}
