---
"emdash": minor
---

**M6 of the autonomous-agent harness roadmap — MCP client.**

Adds `@emdash-cms/plugin-mcp-client`, a JSON-RPC-over-HTTP MCP client that lets operators register external MCP servers (GitHub, Notion, Slack, custom) and auto-bridges their tools into the EmDash tools registry.

Routes:
- `servers.register { name, url, auth?, agent_ids?, allow_tools? }` — register a server, discover its tools via `tools/list`, and bridge each one as `mcp:<server-id>:<tool-name>` in the tools registry. Returns the list of bridged tool names.
- `servers.unregister { id }` — tear down bridges + delete the server.
- `servers.refresh { id }` — re-discover the server's tools (e.g. after the server adds new ones).
- `servers.list`, `servers.tools?id=` — read.

Bridged tools route to `callTool(server, name, args)` which sends `tools/call` JSON-RPC. Responses with `isError: true` surface as `{ ok: false, error: <text> }` to the harness; success paths return the raw `content[]` so agents can read structured payloads (text, image base64, embedded JSON).

Cold-boot behavior: on `plugin:install` we re-bridge from the cached `tool_cache` advertised list — no fan-out to every server on every isolate spin-up. Refresh is explicit.

Authentication: bearer token + basic auth supported. Allowlist by `agent_ids` per server (operator-side control of which agents can reach which MCP servers).

Out of scope (deferred): MCP `prompts/*` and `resources/*` capabilities. Real-world MCP servers mostly use tools; the smaller surface ships value sooner.

Verification: 14 tests across `client.test.ts` (JSON-RPC transport, both auth modes, error paths) and `tool-bridge.test.ts` (registration shape, allow_tools filter, ok/isError handling, unbridge).
