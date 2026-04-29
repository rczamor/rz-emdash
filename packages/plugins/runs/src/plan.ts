/**
 * Plan envelope.
 *
 * An agent emits a multi-step plan as a `<plan>...</plan>` JSON block
 * in an assistant message. The harness parses these blocks, persists
 * the plan on the run, and pauses for human approval. On resume the
 * loop verifies the approval token and continues.
 *
 * Format inside the block is just a JSON Plan. Models occasionally
 * produce malformed JSON; we tolerate that and surface the parse
 * error in the run event log without failing the run — the model
 * gets a chance to retry on the next iteration.
 */

export interface PlanStep {
	ordinal: number;
	action: string;
	tool?: string;
	args?: Record<string, unknown>;
	requires_approval?: boolean;
	estimated_cost_usd?: number;
}

export interface Plan {
	summary: string;
	rationale?: string;
	steps: PlanStep[];
	estimated_total_cost_usd?: number;
	estimated_iterations?: number;
}

const PLAN_BLOCK_RE = /<plan[^>]*>([\s\S]*?)<\/plan>/i;

/** Extract the first plan block from an assistant message body, if any. */
export function extractPlanBlock(content: string | null | undefined): string | null {
	if (!content) return null;
	const found = content.match(PLAN_BLOCK_RE);
	return found?.[1]?.trim() ?? null;
}

/**
 * Parse a plan block. Returns the parsed Plan or an error string. Does
 * not throw — caller decides whether to surface the error.
 */
export function parsePlan(blockBody: string): { ok: true; plan: Plan } | { ok: false; error: string } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(blockBody);
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return { ok: false, error: "Plan must be a JSON object" };
	}
	const obj = parsed as Record<string, unknown>;
	if (typeof obj.summary !== "string") return { ok: false, error: "Plan.summary required (string)" };
	if (!Array.isArray(obj.steps)) return { ok: false, error: "Plan.steps required (array)" };
	const steps: PlanStep[] = [];
	for (const [i, raw] of obj.steps.entries()) {
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
			return { ok: false, error: `Plan.steps[${i}] must be an object` };
		}
		const s = raw as Record<string, unknown>;
		if (typeof s.action !== "string") {
			return { ok: false, error: `Plan.steps[${i}].action required (string)` };
		}
		steps.push({
			ordinal: typeof s.ordinal === "number" ? s.ordinal : i,
			action: s.action,
			tool: typeof s.tool === "string" ? s.tool : undefined,
			args:
				typeof s.args === "object" && s.args !== null && !Array.isArray(s.args)
					? (s.args as Record<string, unknown>)
					: undefined,
			requires_approval:
				typeof s.requires_approval === "boolean" ? s.requires_approval : undefined,
			estimated_cost_usd:
				typeof s.estimated_cost_usd === "number" ? s.estimated_cost_usd : undefined,
		});
	}
	const plan: Plan = {
		summary: obj.summary,
		rationale: typeof obj.rationale === "string" ? obj.rationale : undefined,
		steps,
		estimated_total_cost_usd:
			typeof obj.estimated_total_cost_usd === "number" ? obj.estimated_total_cost_usd : undefined,
		estimated_iterations:
			typeof obj.estimated_iterations === "number" ? obj.estimated_iterations : undefined,
	};
	return { ok: true, plan };
}
