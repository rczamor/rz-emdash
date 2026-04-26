# @emdash-cms/plugin-address

EmDash port of Drupal's Address module. Country-aware postal address
handling with 10 built-in countries, format/validate/parse utilities,
and a webform-compatible field generator.

## Install

```ts
// astro.config.mjs
import { addressPlugin } from "@emdash-cms/plugin-address";

export default defineConfig({
  integrations: [
    emdash({
      plugins: [addressPlugin()],
    }),
  ],
});
```

## Built-in countries

`US`, `CA`, `GB`, `AU`, `DE`, `FR`, `ES`, `IT`, `JP`, `MX`. Each spec
defines:

- Field order (which fields the country uses, in what sequence)
- Required vs optional fields
- Postal-code regex
- Administrative-area subdivisions (US states, Canadian provinces, AU
  states) where useful
- A format string for rendering the address (`%fieldName` placeholders
  with newlines as line separators)

Add more at runtime:

```ts
import { registerCountry } from "@emdash-cms/plugin-address/util";

registerCountry({
  code: "BR",
  name: "Brazil",
  fields: [
    { name: "recipient", label: "Recipient" },
    { name: "addressLine1", label: "Endereço", required: true },
    { name: "locality", label: "Cidade", required: true },
    { name: "administrativeArea", label: "Estado", required: true },
    { name: "postalCode", label: "CEP", required: true },
  ],
  postalCodePattern: "^[0-9]{5}-?[0-9]{3}$",
  format: "%recipient\n%addressLine1\n%locality - %administrativeArea\n%postalCode\n%country",
});
```

## Utility library — `@emdash-cms/plugin-address/util`

Pure functions usable from any plugin or user code:

```ts
import {
  validateAddress, formatAddress,
  webformFieldsForCountry, addressFromSubmission,
} from "@emdash-cms/plugin-address/util";

const errors = validateAddress(
  { addressLine1: "1 Apple Park Way", locality: "Cupertino",
    administrativeArea: "CA", postalCode: "95014" },
  "US",
);
// → []

formatAddress(
  { recipient: "Tim Cook", addressLine1: "1 Apple Park Way",
    locality: "Cupertino", administrativeArea: "CA", postalCode: "95014" },
  "US",
);
// → "Tim Cook
//    1 Apple Park Way
//    Cupertino, CA 95014
//    United States"
```

## Webform integration

Generate a country-correct address sub-form for use in a webform
definition:

```ts
import { webformFieldsForCountry } from "@emdash-cms/plugin-address/util";

const addressFields = webformFieldsForCountry("US", {
  prefix: "shipping_",
  required: true,
});

const form = {
  id: "checkout",
  title: "Checkout",
  fields: [
    { name: "email", type: "email", label: "Email", required: true },
    ...addressFields,  // shipping_recipient, shipping_addressLine1, …
  ],
  enabled: true,
};
```

Then on the server side, after a submission comes in, reassemble the
address from the prefixed fields:

```ts
import { addressFromSubmission, formatAddress } from "@emdash-cms/plugin-address/util";

const shipping = addressFromSubmission(submission.data, "shipping_");
const formatted = formatAddress(shipping, "US");
```

## API routes

```
GET  /_emdash/api/plugins/address/countries.list             public
GET  /_emdash/api/plugins/address/countries.get?code=US      public
POST /_emdash/api/plugins/address/validate                   public
POST /_emdash/api/plugins/address/format                     public
GET  /_emdash/api/plugins/address/webformFields?country=US&prefix=shipping_   admin
```

## Why a plugin if it's mostly utility code?

Same reason as `@emdash-cms/plugin-tokens`: making it appear in
`astro.config.mjs` and the marketplace listing keeps it discoverable.
The descriptor itself has no hooks today.

## Roadmap (not in v1)

- Full CLDR data for ~250 countries (libpostal-style data has license
  considerations — opted out for v1).
- Geocoding integration. Plug a service like Mapbox or Nominatim into
  a separate companion plugin.
- A composite field type for emdash collections themselves (requires
  core field-type extension hooks that don't exist yet).
