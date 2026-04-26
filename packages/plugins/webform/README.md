# @emdash-cms/plugin-webform

EmDash port of Drupal's Webform module. Define forms in JSON, accept public
submissions, store them, and email notifications. Eight common field types,
honeypot anti-spam, per-IP rate limiting.

## Install

```ts
// astro.config.mjs
import { tokensPlugin } from "@emdash-cms/plugin-tokens";
import { webformPlugin } from "@emdash-cms/plugin-webform";

export default defineConfig({
  integrations: [
    emdash({
      plugins: [tokensPlugin(), webformPlugin()],
    }),
  ],
});
```

The webform plugin depends on the tokens plugin for email-template token
replacement, so register both.

## Define a form

POST a definition to the upsert endpoint (admin auth required):

```bash
curl -X POST http://localhost:4321/_emdash/api/plugins/webform/forms.upsert \
  -H "Content-Type: application/json" \
  -H "Cookie: <admin session>" \
  -d '{
    "id": "contact",
    "title": "Contact us",
    "fields": [
      { "name": "name",    "type": "text",     "label": "Your name",    "required": true },
      { "name": "email",   "type": "email",    "label": "Email",        "required": true },
      { "name": "subject", "type": "text",     "label": "Subject",      "maxLength": 100 },
      { "name": "message", "type": "textarea", "label": "Message",      "required": true }
    ],
    "notifications": [{
      "to": "you@example.com",
      "subject": "[{site.name}] {form.title} from {submission.name}",
      "body": "From: {submission.name} <{submission.email}>\nSubject: {submission.subject|default:(none)}\n\n{submission.message}"
    }],
    "rateLimit": { "windowSeconds": 3600, "maxSubmissions": 5 },
    "confirmation": { "message": "Thanks — we will be in touch shortly." },
    "enabled": true
  }'
```

The notification fields go through `@emdash-cms/plugin-tokens` —
`{site.name}`, `{form.title}`, and `{submission.<field-name>}` are
resolved at delivery time.

## Submit a form (public endpoint)

```bash
curl -X POST http://localhost:4321/_emdash/api/plugins/webform/submit \
  -H "Content-Type: application/json" \
  -d '{
    "formId": "contact",
    "data": {
      "name": "Ada",
      "email": "ada@example.com",
      "subject": "Hello",
      "message": "Loving the new CMS."
    }
  }'
```

Response on success:

```json
{ "ok": true, "id": "...", "confirmation": { "message": "Thanks…" } }
```

On validation error:

```json
{ "ok": false, "errors": { "email": "Email must be an email" } }
```

## Field types

| `type`     | Notes |
|------------|-------|
| `text`     | Honors `minLength`, `maxLength`, `pattern` |
| `email`    | Format-validated |
| `textarea` | Honors length limits |
| `number`   | Honors `min` / `max` |
| `url`      | Must be http(s) |
| `tel`      | Free-form (use `pattern` for stricter validation) |
| `select`   | Requires `options: [{ value, label }]` |
| `radio`    | Requires `options: [{ value, label }]` |
| `checkbox` | Submitted value is truthy/falsy |
| `hidden`   | Use for stable values (campaign id, etc.) — bots ignore these |

The submission body can include any `data._hp` honeypot field; if non-empty
the request is logged as spam and a fake-success response is returned to
fool naïve bots.

## Listing & exporting submissions

Admin endpoints:

```
GET  /_emdash/api/plugins/webform/forms.list
GET  /_emdash/api/plugins/webform/forms.get?id=<formId>
GET  /_emdash/api/plugins/webform/submissions.list?formId=<id>&limit=50&cursor=…
GET  /_emdash/api/plugins/webform/submissions.export?formId=<id>   → { csv, filename }
POST /_emdash/api/plugins/webform/forms.delete                     body: { id }
```

The Block Kit admin page at **Settings → Webforms** lists all forms; the
**Recent submissions** dashboard widget shows the latest five.

## Frontend rendering

The plugin owns *data*; your site owns *rendering*. A minimal Astro
component:

```astro
---
const formId = Astro.props.formId ?? "contact";
const res = await fetch(`${Astro.site}/_emdash/api/plugins/webform/forms.get?id=${formId}`);
const { form } = await res.json();
---
<form method="POST" action="/_emdash/api/plugins/webform/submit" enctype="application/json">
  <input type="hidden" name="formId" value={form.id} />
  <input type="text" name="data._hp" autocomplete="off" tabindex="-1"
         style="position:absolute;left:-9999px" aria-hidden="true" />
  {form.fields.map(f => (
    <label>
      {f.label}
      <input type={f.type} name={`data.${f.name}`} required={f.required} />
    </label>
  ))}
  <button type="submit">Submit</button>
</form>
```

For real use you'll want client-side JS to wrap the body in JSON and
display the validation errors — the plugin's submit endpoint expects a
JSON body.

## Roadmap (not in v1)

- File uploads (requires `write:media` capability)
- Conditional logic (show field X if field Y == Z)
- Multi-step forms
- Drag-drop form builder admin (Block Kit can list/edit form JSON, but
  not a true visual builder)
- Webhook delivery on submission (could compose with the
  `webhook-notifier` plugin later)
