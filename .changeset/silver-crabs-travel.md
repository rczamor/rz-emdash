---
"@emdash-cms/admin": patch
---

Fixes Kumo Input accessibility warnings in the editor toolbar/bubble menu, section pickers, and Block Kit field renderers by adding `aria-label` props. Migrates admin browser tests from the deprecated `@vitest/browser/context` import path to `vitest/browser`.
