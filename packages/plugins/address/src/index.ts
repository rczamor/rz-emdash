/**
 * Address Plugin for EmDash CMS
 *
 * EmDash port of Drupal's Address module. Provides:
 *
 *   - 10 country specs (US, CA, GB, AU, DE, FR, ES, IT, JP, MX) with
 *     correct field order, postal-code patterns, and administrative-area
 *     subdivisions where applicable.
 *   - A pure utility library at `@emdash-cms/plugin-address/util`:
 *
 *       import {
 *         validateAddress, formatAddress,
 *         webformFieldsForCountry, addressFromSubmission,
 *       } from "@emdash-cms/plugin-address/util";
 *
 *   - The country data itself at `@emdash-cms/plugin-address/countries`
 *     for advanced consumers who want to introspect or extend.
 *   - Runtime registration of additional countries via `registerCountry()`.
 *
 * Webform integration: `webformFieldsForCountry("US")` returns a
 * webform-shaped `fields` array you can splice into a form definition.
 */

import type { PluginDescriptor } from "emdash";

export type {
	AddressFieldName,
	AddressFieldSpec,
	CountrySpec,
} from "./countries.js";
export type { Address, ValidationError } from "./util.js";

export function addressPlugin(): PluginDescriptor {
	return {
		id: "address",
		version: "0.0.1",
		format: "standard",
		entrypoint: "@emdash-cms/plugin-address/sandbox",
		options: {},
		adminPages: [{ path: "/address", label: "Address", icon: "map-pin" }],
	};
}
