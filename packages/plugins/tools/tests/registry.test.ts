import { beforeEach, describe, expect, it, vi } from "vitest";

import {
	_resetTools,
	getTool,
	listTools,
	listToolNames,
	registerTool,
	unregisterTool,
} from "../src/registry.js";
import type { Tool } from "../src/types.js";

const mkTool = (name: string, extra: Partial<Tool> = {}): Tool => ({
	name,
	description: `${name} tool`,
	parameters: { type: "object" },
	handler: async () => ({ ok: true }),
	...extra,
});

beforeEach(() => _resetTools());

describe("registerTool / getTool", () => {
	it("registers and retrieves by name", () => {
		const t = mkTool("content_list");
		registerTool(t);
		expect(getTool("content_list")).toBe(t);
	});

	it("returns undefined for unknown name", () => {
		expect(getTool("nope")).toBeUndefined();
	});

	it.each<[string, Partial<Tool>]>([
		["missing name", { name: "" }],
		["missing description", { description: "" }],
	])("rejects invalid tool: %s", (_, override) => {
		expect(() => registerTool(mkTool("x", override))).toThrow(
			/requires name, description, parameters, and handler/,
		);
	});

	it("warns and overwrites when re-registering", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const a = mkTool("dup");
		const b = mkTool("dup", { description: "replacement" });
		registerTool(a);
		registerTool(b);
		expect(warn).toHaveBeenCalledWith(expect.stringMatching(/already registered/));
		expect(getTool("dup")).toBe(b);
		warn.mockRestore();
	});
});

describe("listTools / listToolNames", () => {
	it("returns sorted by name", () => {
		registerTool(mkTool("zebra"));
		registerTool(mkTool("apple"));
		registerTool(mkTool("mango"));
		expect(listToolNames()).toEqual(["apple", "mango", "zebra"]);
		expect(listTools().map((t) => t.name)).toEqual(["apple", "mango", "zebra"]);
	});

	it("returns empty arrays when registry is empty", () => {
		expect(listTools()).toEqual([]);
		expect(listToolNames()).toEqual([]);
	});
});

describe("unregisterTool", () => {
	it("returns true when tool existed", () => {
		registerTool(mkTool("rm"));
		expect(unregisterTool("rm")).toBe(true);
		expect(getTool("rm")).toBeUndefined();
	});

	it("returns false when tool did not exist", () => {
		expect(unregisterTool("never")).toBe(false);
	});
});
