import { beforeEach, describe, expect, it, vi } from "vitest";

import {
	_resetJobHandlers,
	getJobHandler,
	listJobHandlers,
	registerJobHandler,
	unregisterJobHandler,
	type JobHandler,
} from "../src/registry.js";

const noop: JobHandler = async () => {};

beforeEach(() => _resetJobHandlers());

describe("registerJobHandler / getJobHandler", () => {
	it("registers and retrieves by name", () => {
		registerJobHandler("audit:cleanup", noop);
		expect(getJobHandler("audit:cleanup")).toBe(noop);
	});

	it("returns undefined for unknown name", () => {
		expect(getJobHandler("missing")).toBeUndefined();
	});

	it("warns when overwriting an existing handler", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		registerJobHandler("dup", noop);
		registerJobHandler("dup", async () => {});
		expect(warn).toHaveBeenCalledWith(expect.stringMatching(/already registered/));
		warn.mockRestore();
	});

	it("overwrite replaces the previous handler", () => {
		const a: JobHandler = async () => {};
		const b: JobHandler = async () => {};
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		registerJobHandler("k", a);
		registerJobHandler("k", b);
		expect(getJobHandler("k")).toBe(b);
		warn.mockRestore();
	});
});

describe("listJobHandlers", () => {
	it("returns sorted names", () => {
		registerJobHandler("zebra", noop);
		registerJobHandler("apple", noop);
		registerJobHandler("mango", noop);
		expect(listJobHandlers()).toEqual(["apple", "mango", "zebra"]);
	});

	it("returns [] when empty", () => {
		expect(listJobHandlers()).toEqual([]);
	});
});

describe("unregisterJobHandler", () => {
	it("returns true when handler existed", () => {
		registerJobHandler("rm", noop);
		expect(unregisterJobHandler("rm")).toBe(true);
		expect(getJobHandler("rm")).toBeUndefined();
	});

	it("returns false when handler did not exist", () => {
		expect(unregisterJobHandler("never-registered")).toBe(false);
	});
});
