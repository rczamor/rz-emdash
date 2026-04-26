/**
 * Address utility library.
 *
 * Pure functions any plugin or user code can import via
 * `@emdash-cms/plugin-address/util`.
 */

import { COUNTRIES, type AddressFieldName, type AddressFieldSpec, type CountrySpec } from "./countries.js";

export type Address = Partial<Record<AddressFieldName, string>>;

export interface ValidationError {
	field: AddressFieldName;
	message: string;
}

const RUNTIME_REGISTRY: Record<string, CountrySpec> = {};

export function registerCountry(spec: CountrySpec): void {
	RUNTIME_REGISTRY[spec.code] = spec;
}

export function getCountry(code: string): CountrySpec | null {
	return RUNTIME_REGISTRY[code] ?? COUNTRIES[code] ?? null;
}

export function listCountries(): Array<{ code: string; name: string }> {
	const merged: Record<string, CountrySpec> = { ...COUNTRIES, ...RUNTIME_REGISTRY };
	return Object.values(merged)
		.map((c) => ({ code: c.code, name: c.name }))
		.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Validate an address against a country's rules. Returns an array of
 * field-level errors. Empty array means valid.
 */
export function validateAddress(address: Address, countryCode: string): ValidationError[] {
	const country = getCountry(countryCode);
	if (!country) return [{ field: "country", message: `Unsupported country: ${countryCode}` }];
	const errors: ValidationError[] = [];

	for (const f of country.fields) {
		const value = address[f.name];
		if (f.required && (!value || !value.trim())) {
			errors.push({ field: f.name, message: `${f.label} is required` });
			continue;
		}
		if (
			f.name === "postalCode" &&
			value &&
			country.postalCodePattern &&
			!new RegExp(country.postalCodePattern).test(value)
		) {
			errors.push({ field: f.name, message: `${f.label} has the wrong format` });
		}
		if (
			f.name === "administrativeArea" &&
			value &&
			country.subdivisions &&
			!country.subdivisions.some((s) => s.value === value)
		) {
			errors.push({ field: f.name, message: `${f.label} is not a valid choice` });
		}
	}

	return errors;
}

/**
 * Render an address to a multi-line string in the country's preferred order.
 * Empty fields are skipped (and their separators collapse).
 */
export function formatAddress(address: Address, countryCode: string): string {
	const country = getCountry(countryCode);
	if (!country) return "";

	const lookup = (name: string): string => {
		if (name === "country") return country.name;
		return (address[name as AddressFieldName] ?? "").trim();
	};

	return country.format
		.split("\n")
		.map((line) =>
			line
				.replace(/%([a-zA-Z]+)/g, (_, key: string) => lookup(key))
				.replace(/\s{2,}/g, " ")
				.replace(/\s*,\s*,/g, ",")
				.trim(),
		)
		.filter((line) => line && line !== ",")
		.join("\n");
}

/**
 * Build webform-compatible field definitions for a country's address.
 * Pass through to a webform `fields` array — each address subfield becomes
 * an individual top-level form field.
 *
 * Field names are prefixed with `prefix` (default "address_") so a single
 * form can host multiple addresses (`shipping_`, `billing_`, etc.).
 */
export function webformFieldsForCountry(
	countryCode: string,
	options: { prefix?: string; required?: boolean } = {},
): Array<{
	name: string;
	type: string;
	label: string;
	required?: boolean;
	helpText?: string;
	options?: Array<{ value: string; label: string }>;
}> {
	const country = getCountry(countryCode);
	if (!country) return [];
	const prefix = options.prefix ?? "address_";
	return country.fields.map((f: AddressFieldSpec) => {
		const def: ReturnType<typeof webformFieldsForCountry>[number] = {
			name: prefix + f.name,
			type: f.name === "administrativeArea" && country.subdivisions ? "select" : "text",
			label: f.label,
			required: f.required ?? options.required,
			helpText: f.helpText,
		};
		if (f.name === "administrativeArea" && country.subdivisions) {
			def.options = country.subdivisions;
		}
		return def;
	});
}

/**
 * Pull a structured Address back out of a flat submission object.
 */
export function addressFromSubmission(
	submission: Record<string, unknown>,
	prefix = "address_",
): Address {
	const out: Address = {};
	for (const key of Object.keys(submission)) {
		if (!key.startsWith(prefix)) continue;
		const fname = key.slice(prefix.length) as AddressFieldName;
		const value = submission[key];
		if (typeof value === "string") out[fname] = value;
	}
	return out;
}

export type { AddressFieldName, AddressFieldSpec, CountrySpec } from "./countries.js";
