/**
 * Composite address field helpers.
 *
 * EmDash collections support a `json` field type ([packages/core/src/schema/types.ts](../../core/src/schema/types.ts)).
 * That's the natural home for a structured address: store all the
 * subfields in a single JSON column, get back a typed object on read.
 *
 * Two helpers here:
 *
 *   - `addressFieldSeed()` — drop into a collection's `fields` array in
 *     seed.json. Produces a JSON field annotated with a recommended
 *     editor hint.
 *
 *   - `addressJsonShape()` — describe the value shape so user code can
 *     reconstruct/validate addresses on read or in a `content:beforeSave`
 *     hook.
 *
 * Why no built-in beforeSave validator? Plugins can't read collection
 * schemas to know which fields are addresses without per-collection
 * configuration. Until emdash exposes a schema-introspection hook,
 * users wire validation explicitly in their own code (or in their own
 * pre-save plugin).
 */

import { validateAddress } from "./util.js";
import type { Address } from "./util.js";

export interface AddressFieldSeedOptions {
	slug: string;
	label: string;
	helpText?: string;
	required?: boolean;
}

/**
 * Build a seed-shape field definition for a composite address. Splice
 * the result into your seed.json's `fields` array:
 *
 *   {
 *     "slug": "posts",
 *     "fields": [
 *       { "slug": "title", "label": "Title", "type": "string" },
 *       <addressFieldSeed({ slug: "shipping", label: "Shipping address" })>
 *     ]
 *   }
 */
export function addressFieldSeed(options: AddressFieldSeedOptions): {
	slug: string;
	label: string;
	type: "json";
	required?: boolean;
	helpText?: string;
} {
	return {
		slug: options.slug,
		label: options.label,
		type: "json",
		required: options.required,
		helpText:
			options.helpText ??
			"Composite address. Stored as JSON: { recipient, addressLine1, addressLine2, locality, administrativeArea, postalCode }.",
	};
}

/**
 * Describe the shape of a stored address. Useful for documentation
 * tooling, schema generation, and validation.
 */
export function addressJsonShape(): Record<string, "string"> {
	return {
		recipient: "string",
		organization: "string",
		addressLine1: "string",
		addressLine2: "string",
		dependentLocality: "string",
		locality: "string",
		administrativeArea: "string",
		postalCode: "string",
		sortingCode: "string",
		country: "string",
	};
}

/**
 * Validate a value claimed to be an address. Suitable for use inside a
 * `content:beforeSave` hook in the consumer's own plugin.
 *
 *   import { isAddress, validateStoredAddress } from "@emdash-cms/plugin-address/composite";
 *
 *   "content:beforeSave": async (event) => {
 *     const value = event.content.shipping;
 *     if (isAddress(value)) {
 *       const errors = validateStoredAddress(value, "US");
 *       if (errors.length) throw new Error(errors[0].message);
 *     }
 *   }
 */
export function isAddress(value: unknown): value is Address {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const obj = value as Record<string, unknown>;
	const allowed = new Set([
		"recipient",
		"organization",
		"addressLine1",
		"addressLine2",
		"dependentLocality",
		"locality",
		"administrativeArea",
		"postalCode",
		"sortingCode",
		"country",
	]);
	for (const key of Object.keys(obj)) {
		if (!allowed.has(key)) return false;
		if (obj[key] != null && typeof obj[key] !== "string") return false;
	}
	return true;
}

export function validateStoredAddress(
	value: unknown,
	country: string,
): { field: string; message: string }[] {
	if (!isAddress(value)) return [{ field: "_root", message: "Not a valid address shape" }];
	return validateAddress(value, country).map((e) => ({ field: e.field, message: e.message }));
}
