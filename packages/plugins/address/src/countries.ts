/**
 * Country data for the Address plugin.
 *
 * Each country defines:
 *  - the field set its postal addresses use
 *  - the canonical line order for rendering
 *  - administrative-area subdivisions (states/provinces) where useful
 *  - a postal-code regex
 *
 * Ten countries ship out of the box. Additional countries can be
 * registered at runtime via `registerCountry()` from `./util`.
 *
 * Format strings reference field names with `%fieldName` (USPS-style).
 * `\n` separates lines.
 */

export type AddressFieldName =
	| "recipient"
	| "organization"
	| "addressLine1"
	| "addressLine2"
	| "dependentLocality"
	| "locality"
	| "administrativeArea"
	| "postalCode"
	| "sortingCode"
	| "country";

export interface AddressFieldSpec {
	name: AddressFieldName;
	label: string;
	required?: boolean;
	helpText?: string;
}

export interface CountrySpec {
	code: string;
	name: string;
	fields: AddressFieldSpec[];
	subdivisions?: Array<{ value: string; label: string }>;
	postalCodePattern?: string;
	format: string;
}

const US_STATES = [
	["AL", "Alabama"],
	["AK", "Alaska"],
	["AZ", "Arizona"],
	["AR", "Arkansas"],
	["CA", "California"],
	["CO", "Colorado"],
	["CT", "Connecticut"],
	["DE", "Delaware"],
	["FL", "Florida"],
	["GA", "Georgia"],
	["HI", "Hawaii"],
	["ID", "Idaho"],
	["IL", "Illinois"],
	["IN", "Indiana"],
	["IA", "Iowa"],
	["KS", "Kansas"],
	["KY", "Kentucky"],
	["LA", "Louisiana"],
	["ME", "Maine"],
	["MD", "Maryland"],
	["MA", "Massachusetts"],
	["MI", "Michigan"],
	["MN", "Minnesota"],
	["MS", "Mississippi"],
	["MO", "Missouri"],
	["MT", "Montana"],
	["NE", "Nebraska"],
	["NV", "Nevada"],
	["NH", "New Hampshire"],
	["NJ", "New Jersey"],
	["NM", "New Mexico"],
	["NY", "New York"],
	["NC", "North Carolina"],
	["ND", "North Dakota"],
	["OH", "Ohio"],
	["OK", "Oklahoma"],
	["OR", "Oregon"],
	["PA", "Pennsylvania"],
	["RI", "Rhode Island"],
	["SC", "South Carolina"],
	["SD", "South Dakota"],
	["TN", "Tennessee"],
	["TX", "Texas"],
	["UT", "Utah"],
	["VT", "Vermont"],
	["VA", "Virginia"],
	["WA", "Washington"],
	["WV", "West Virginia"],
	["WI", "Wisconsin"],
	["WY", "Wyoming"],
	["DC", "District of Columbia"],
] satisfies ReadonlyArray<readonly [string, string]>;

const CA_PROVINCES = [
	["AB", "Alberta"],
	["BC", "British Columbia"],
	["MB", "Manitoba"],
	["NB", "New Brunswick"],
	["NL", "Newfoundland and Labrador"],
	["NS", "Nova Scotia"],
	["NT", "Northwest Territories"],
	["NU", "Nunavut"],
	["ON", "Ontario"],
	["PE", "Prince Edward Island"],
	["QC", "Quebec"],
	["SK", "Saskatchewan"],
	["YT", "Yukon"],
] satisfies ReadonlyArray<readonly [string, string]>;

const AU_STATES = [
	["ACT", "Australian Capital Territory"],
	["NSW", "New South Wales"],
	["NT", "Northern Territory"],
	["QLD", "Queensland"],
	["SA", "South Australia"],
	["TAS", "Tasmania"],
	["VIC", "Victoria"],
	["WA", "Western Australia"],
] satisfies ReadonlyArray<readonly [string, string]>;

function toSubdivisions(arr: ReadonlyArray<readonly [string, string]>) {
	return arr.map(([value, label]) => ({ value, label }));
}

const FIELDS_NAME_LINES_LOCALITY: AddressFieldSpec[] = [
	{ name: "recipient", label: "Recipient" },
	{ name: "addressLine1", label: "Street address", required: true },
	{ name: "addressLine2", label: "Apt / suite / unit" },
	{ name: "locality", label: "City", required: true },
];

export const COUNTRIES: Record<string, CountrySpec> = {
	US: {
		code: "US",
		name: "United States",
		fields: [
			...FIELDS_NAME_LINES_LOCALITY,
			{ name: "administrativeArea", label: "State", required: true },
			{ name: "postalCode", label: "ZIP code", required: true },
		],
		subdivisions: toSubdivisions(US_STATES),
		postalCodePattern: "^[0-9]{5}(-[0-9]{4})?$",
		format: "%recipient\n%addressLine1\n%addressLine2\n%locality, %administrativeArea %postalCode\n%country",
	},
	CA: {
		code: "CA",
		name: "Canada",
		fields: [
			...FIELDS_NAME_LINES_LOCALITY,
			{ name: "administrativeArea", label: "Province", required: true },
			{ name: "postalCode", label: "Postal code", required: true },
		],
		subdivisions: toSubdivisions(CA_PROVINCES),
		postalCodePattern: "^[A-Za-z][0-9][A-Za-z][ ]?[0-9][A-Za-z][0-9]$",
		format: "%recipient\n%addressLine1\n%addressLine2\n%locality %administrativeArea %postalCode\n%country",
	},
	GB: {
		code: "GB",
		name: "United Kingdom",
		fields: [
			...FIELDS_NAME_LINES_LOCALITY,
			{ name: "postalCode", label: "Postcode", required: true },
		],
		postalCodePattern:
			"^([Gg][Ii][Rr] 0[Aa]{2})|((([A-Za-z][0-9]{1,2})|(([A-Za-z][A-Ha-hJ-Yj-y][0-9]{1,2})|(([A-Za-z][0-9][A-Za-z])|([A-Za-z][A-Ha-hJ-Yj-y][0-9]?[A-Za-z]))))[ ]?[0-9][A-Za-z]{2})$",
		format: "%recipient\n%addressLine1\n%addressLine2\n%locality\n%postalCode\n%country",
	},
	AU: {
		code: "AU",
		name: "Australia",
		fields: [
			...FIELDS_NAME_LINES_LOCALITY,
			{ name: "administrativeArea", label: "State", required: true },
			{ name: "postalCode", label: "Postcode", required: true },
		],
		subdivisions: toSubdivisions(AU_STATES),
		postalCodePattern: "^[0-9]{4}$",
		format: "%recipient\n%addressLine1\n%addressLine2\n%locality %administrativeArea %postalCode\n%country",
	},
	DE: {
		code: "DE",
		name: "Germany",
		fields: [
			...FIELDS_NAME_LINES_LOCALITY,
			{ name: "postalCode", label: "Postleitzahl", required: true },
		],
		postalCodePattern: "^[0-9]{5}$",
		format: "%recipient\n%addressLine1\n%addressLine2\n%postalCode %locality\n%country",
	},
	FR: {
		code: "FR",
		name: "France",
		fields: [
			...FIELDS_NAME_LINES_LOCALITY,
			{ name: "postalCode", label: "Code postal", required: true },
		],
		postalCodePattern: "^[0-9]{5}$",
		format: "%recipient\n%addressLine1\n%addressLine2\n%postalCode %locality\n%country",
	},
	ES: {
		code: "ES",
		name: "Spain",
		fields: [
			...FIELDS_NAME_LINES_LOCALITY,
			{ name: "postalCode", label: "Código postal", required: true },
			{ name: "administrativeArea", label: "Province" },
		],
		postalCodePattern: "^[0-9]{5}$",
		format: "%recipient\n%addressLine1\n%addressLine2\n%postalCode %locality %administrativeArea\n%country",
	},
	IT: {
		code: "IT",
		name: "Italy",
		fields: [
			...FIELDS_NAME_LINES_LOCALITY,
			{ name: "postalCode", label: "CAP", required: true },
			{ name: "administrativeArea", label: "Province" },
		],
		postalCodePattern: "^[0-9]{5}$",
		format: "%recipient\n%addressLine1\n%addressLine2\n%postalCode %locality %administrativeArea\n%country",
	},
	JP: {
		code: "JP",
		name: "Japan",
		fields: [
			{ name: "recipient", label: "Recipient" },
			{ name: "postalCode", label: "Postal code", required: true },
			{ name: "administrativeArea", label: "Prefecture", required: true },
			{ name: "locality", label: "City / ward", required: true },
			{ name: "addressLine1", label: "Address", required: true },
			{ name: "addressLine2", label: "Building / floor" },
		],
		postalCodePattern: "^[0-9]{3}-?[0-9]{4}$",
		format: "%postalCode\n%administrativeArea %locality\n%addressLine1\n%addressLine2\n%recipient\n%country",
	},
	MX: {
		code: "MX",
		name: "Mexico",
		fields: [
			...FIELDS_NAME_LINES_LOCALITY,
			{ name: "administrativeArea", label: "State", required: true },
			{ name: "postalCode", label: "C.P.", required: true },
		],
		postalCodePattern: "^[0-9]{5}$",
		format: "%recipient\n%addressLine1\n%addressLine2\n%locality, %administrativeArea %postalCode\n%country",
	},
};

export const COUNTRY_CODES = Object.keys(COUNTRIES);
