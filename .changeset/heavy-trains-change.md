---
"emdash": patch
---

Fixes internal plugin API authentication so redirected external plugin HTTP requests cannot receive internal bypass headers, and strips those internal headers before sandboxed route code receives request metadata.
