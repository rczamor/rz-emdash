/**
 * M3 — plan envelope + approval gates.
 */

import { describe, expect, it } from "vitest";

import { extractPlanBlock, parsePlan } from "../src/plan.js";
import { newApprovalToken, shouldGate } from "../src/approval.js";

describe("extractPlanBlock", () => {
	it("returns the inner content of a plan block", () => {
		const out = extractPlanBlock("preamble <plan>{\"summary\":\"x\"}</plan> postscript");
		expect(out).toBe('{"summary":"x"}');
	});

	it("returns null when no block present", () => {
		expect(extractPlanBlock("just text")).toBeNull();
	});

	it("handles multi-line plan blocks", () => {
		const md = `Here is my plan:
<plan>
{
  "summary": "draft + publish",
  "steps": []
}
</plan>
End.`;
		expect(extractPlanBlock(md)).toContain("\"summary\"");
	});

	it("returns null for null/undefined/empty input", () => {
		expect(extractPlanBlock(null)).toBeNull();
		expect(extractPlanBlock(undefined)).toBeNull();
		expect(extractPlanBlock("")).toBeNull();
	});

	it("matches case-insensitively", () => {
		expect(extractPlanBlock("<PLAN>x</PLAN>")).toBe("x");
	});
});

describe("parsePlan", () => {
	it("parses a minimal valid plan", () => {
		const result = parsePlan('{"summary":"draft post","steps":[]}');
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.plan.summary).toBe("draft post");
			expect(result.plan.steps).toEqual([]);
		}
	});

	it("parses a plan with steps", () => {
		const json = JSON.stringify({
			summary: "publish",
			rationale: "ready",
			steps: [
				{ ordinal: 1, action: "draft", tool: "content_create" },
				{ ordinal: 2, action: "publish", tool: "content_publish", requires_approval: true },
			],
			estimated_total_cost_usd: 0.05,
		});
		const result = parsePlan(json);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.plan.steps).toHaveLength(2);
			expect(result.plan.steps[1]?.requires_approval).toBe(true);
			expect(result.plan.estimated_total_cost_usd).toBe(0.05);
		}
	});

	it("rejects non-object JSON", () => {
		expect(parsePlan("[]").ok).toBe(false);
		expect(parsePlan('"x"').ok).toBe(false);
		expect(parsePlan("null").ok).toBe(false);
	});

	it("rejects malformed JSON without throwing", () => {
		const result = parsePlan("{not json}");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toMatch(/JSON|Unexpected|expect|token/i);
	});

	it("rejects when summary missing", () => {
		const result = parsePlan('{"steps":[]}');
		expect(result.ok).toBe(false);
	});

	it("rejects when steps missing", () => {
		const result = parsePlan('{"summary":"x"}');
		expect(result.ok).toBe(false);
	});

	it("rejects when a step lacks action", () => {
		const result = parsePlan('{"summary":"x","steps":[{}]}');
		expect(result.ok).toBe(false);
	});

	it("auto-fills ordinal when missing", () => {
		const result = parsePlan('{"summary":"x","steps":[{"action":"a"},{"action":"b"}]}');
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.plan.steps.map((s) => s.ordinal)).toEqual([0, 1]);
		}
	});
});

describe("shouldGate", () => {
	it("gates always-gated tools by default", () => {
		expect(shouldGate({ tool: "content_publish", current_cost_usd: 0 }).gate).toBe(true);
		expect(shouldGate({ tool: "content_delete", current_cost_usd: 0 }).gate).toBe(true);
		expect(shouldGate({ tool: "media_delete", current_cost_usd: 0 }).gate).toBe(true);
	});

	it("does not gate read-only tools", () => {
		expect(shouldGate({ tool: "content_get", current_cost_usd: 0 }).gate).toBe(false);
		expect(shouldGate({ tool: "web_fetch", current_cost_usd: 0 }).gate).toBe(false);
	});

	it("respects custom always_gate", () => {
		expect(
			shouldGate({
				tool: "web_fetch",
				current_cost_usd: 0,
				config: { always_gate: ["web_fetch"] },
			}).gate,
		).toBe(true);
	});

	it("respects never_gate override (even on default-gated tools)", () => {
		expect(
			shouldGate({
				tool: "content_publish",
				current_cost_usd: 0,
				config: { never_gate: ["content_publish"] },
			}).gate,
		).toBe(false);
	});

	it("gates when projected cost exceeds threshold", () => {
		const r = shouldGate({
			tool: "web_fetch",
			estimated_step_cost_usd: 2.0,
			current_cost_usd: 0,
			config: { max_usd_unattended: 1.0 },
		});
		expect(r.gate).toBe(true);
		expect(r.reason).toMatch(/exceeds/);
	});

	it("uses $1.00 default threshold when not configured", () => {
		expect(
			shouldGate({
				tool: "web_fetch",
				estimated_step_cost_usd: 0.5,
				current_cost_usd: 0.6,
			}).gate,
		).toBe(true);
	});

	it("never_gate beats always_gate on conflict", () => {
		const r = shouldGate({
			tool: "content_publish",
			current_cost_usd: 0,
			config: { never_gate: ["content_publish"], always_gate: ["content_publish"] },
		});
		expect(r.gate).toBe(false);
	});
});

describe("newApprovalToken", () => {
	it("generates unique single-use tokens", () => {
		const tokens = new Set();
		for (let i = 0; i < 100; i++) tokens.add(newApprovalToken());
		expect(tokens.size).toBe(100);
		for (const t of tokens) expect(String(t)).toMatch(/^apr_/);
	});
});
