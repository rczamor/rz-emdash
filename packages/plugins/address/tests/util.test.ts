import { afterEach, describe, expect, it } from "vitest";

import { isAddress, validateStoredAddress } from "../src/composite.js";
import {
	_clearRuntimeCountries,
	addressFromSubmission,
	formatAddress,
	getCountry,
	listCountries,
	registerCountry,
	validateAddress,
	webformFieldsForCountry,
} from "../src/util.js";

describe("getCountry / listCountries", () => {
	afterEach(() => _clearRuntimeCountries());

	it("returns built-in countries", () => {
		expect(getCountry("US")?.name).toBe("United States");
		expect(getCountry("FR")?.name).toBe("France");
	});

	it("returns null for unknown", () => {
		expect(getCountry("ZZ")).toBeNull();
	});

	it("listCountries is sorted alphabetically", () => {
		const list = listCountries();
		expect(list.length).toBeGreaterThanOrEqual(10);
		const names = list.map((c) => c.name);
		expect(names.toSorted()).toEqual(names);
	});

	it("registerCountry adds a runtime country", () => {
		registerCountry({
			code: "ZZ",
			name: "Zedland",
			fields: [{ name: "addressLine1", label: "Street", required: true }],
			format: "%addressLine1\n%country",
		});
		expect(getCountry("ZZ")?.name).toBe("Zedland");
	});

	it("registerCountry overrides a built-in", () => {
		registerCountry({
			code: "US",
			name: "Override",
			fields: [{ name: "addressLine1", label: "Street", required: true }],
			format: "%addressLine1\n%country",
		});
		expect(getCountry("US")?.name).toBe("Override");
	});
});

describe("validateAddress", () => {
	it("flags unsupported country", () => {
		const errs = validateAddress({}, "QQ");
		expect(errs[0].field).toBe("country");
	});

	it("requires required fields", () => {
		const errs = validateAddress({}, "US");
		expect(errs.find((e) => e.field === "addressLine1")).toBeDefined();
		expect(errs.find((e) => e.field === "locality")).toBeDefined();
	});

	it("validates US ZIP format", () => {
		const errs = validateAddress(
			{ addressLine1: "1 Main", locality: "SF", administrativeArea: "CA", postalCode: "abc" },
			"US",
		);
		expect(errs.find((e) => e.field === "postalCode")).toBeDefined();
	});

	it("accepts valid 5-digit ZIP", () => {
		const errs = validateAddress(
			{ addressLine1: "1 Main", locality: "SF", administrativeArea: "CA", postalCode: "94102" },
			"US",
		);
		expect(errs).toEqual([]);
	});

	it("rejects unknown US state", () => {
		const errs = validateAddress(
			{ addressLine1: "1 Main", locality: "SF", administrativeArea: "ZZ", postalCode: "94102" },
			"US",
		);
		expect(errs.find((e) => e.field === "administrativeArea")).toBeDefined();
	});
});

describe("formatAddress", () => {
	const us = {
		recipient: "Alice",
		addressLine1: "1 Main St",
		addressLine2: "Apt 5",
		locality: "SF",
		administrativeArea: "CA",
		postalCode: "94102",
	};

	it("renders US in canonical order with digit-suffixed fields resolved", () => {
		const out = formatAddress(us, "US");
		expect(out).toContain("Alice");
		expect(out).toContain("1 Main St");
		expect(out).toContain("Apt 5");
		expect(out).toContain("SF, CA 94102");
		expect(out).toContain("United States");
		// Digit suffix must not leak as a literal — regression for the
		// `%([a-zA-Z]+)` regex that captured `addressLine` and emitted `1`.
		expect(out).not.toMatch(/St 1\b/);
	});

	it("returns empty string for unknown country", () => {
		expect(formatAddress({}, "QQ")).toBe("");
	});

	it("skips empty lines", () => {
		const out = formatAddress(us, "US");
		expect(out.startsWith("\n")).toBe(false);
	});
});

describe("webformFieldsForCountry", () => {
	it("emits prefixed fields", () => {
		const fields = webformFieldsForCountry("US", { prefix: "shipping_" });
		expect(fields.length).toBeGreaterThan(0);
		expect(fields.every((f) => f.name.startsWith("shipping_"))).toBe(true);
	});

	it("renders administrativeArea as select with options", () => {
		const fields = webformFieldsForCountry("US");
		const state = fields.find((f) => f.name.endsWith("administrativeArea"));
		expect(state?.type).toBe("select");
		expect(state?.options?.length).toBeGreaterThan(40);
	});

	it("returns [] for unknown country", () => {
		expect(webformFieldsForCountry("QQ")).toEqual([]);
	});
});

describe("addressFromSubmission", () => {
	it("extracts fields with prefix", () => {
		const out = addressFromSubmission(
			{ shipping_addressLine1: "1 Main", shipping_locality: "SF", other: "x" },
			"shipping_",
		);
		expect(out).toEqual({ addressLine1: "1 Main", locality: "SF" });
	});

	it("default prefix is address_", () => {
		const out = addressFromSubmission({ address_locality: "SF" });
		expect(out.locality).toBe("SF");
	});
});

describe("composite.isAddress / validateStoredAddress", () => {
	it("isAddress accepts valid shape", () => {
		expect(isAddress({ addressLine1: "x", locality: "y" })).toBe(true);
	});

	it("isAddress rejects unknown keys", () => {
		expect(isAddress({ foo: "bar" })).toBe(false);
	});

	it("isAddress rejects null/array/non-object", () => {
		expect(isAddress(null)).toBe(false);
		expect(isAddress([])).toBe(false);
		expect(isAddress("x")).toBe(false);
	});

	it("validateStoredAddress flags wrong shape", () => {
		const errs = validateStoredAddress({ foo: "bar" }, "US");
		expect(errs[0].field).toBe("_root");
	});

	it("validateStoredAddress passes through to validateAddress", () => {
		const errs = validateStoredAddress({}, "US");
		expect(errs.find((e) => e.field === "addressLine1")).toBeDefined();
	});
});
