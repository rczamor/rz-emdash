# @emdash-cms/plugin-tools

In-process tool registry for LLM tool calling. Wraps emdash's
content / Tasks / Agents APIs as tools an internal agent can invoke
during a chat completion. Companion to the OpenRouter plugin (which
runs the tool-call loop) and the Agents plugin (which holds the
per-agent allowlist).

## Why this plugin

EmDash core's MCP server exposes 33 tools to **external** MCP
clients (Claude Desktop, Cursor) at `/_emdash/api/mcp`. Internal
agents — those orchestrated by Tasks / Automations / OpenRouter —
couldn't access them: there was no in-process catalog OpenRouter's
chat loop could inject as `tools: [...]`, no per-agent allowlist,
and no execution loop.

This plugin fills the gap. Built-in tools wrap the essentials; the
registry lets other plugins add more.

## Install

```ts
// astro.config.mjs
import { toolsPlugin } from "@emdash-cms/plugin-tools";

export default defineConfig({
  integrations: [
    emdash({ plugins: [toolsPlugin()] }),
  ],
});
```

## Built-in tools

| Tool | Wraps |
|---|---|
| `content_list` | `ctx.content.list` |
| `content_get` | `ctx.content.get` |
| `content_search` | substring scan over a collection |
| `task_create` | POST `tasks.create` |
| `task_advance` | POST `tasks.transition` |
| `memory_search` | POST `agents/memory.search` |
| `memory_put` | POST `agents/memory.put` |

That covers a typical writer-agent workflow: read source content,
spawn sub-tasks, advance state, persist decisions.

## Registering custom tools

```ts
import { registerTool } from "@emdash-cms/plugin-tools/registry";

registerTool({
  name: "weather_get",
  description: "Get the current weather for a city.",
  parameters: {
    type: "object",
    properties: {
      city: { type: "string" },
      units: { type: "string", enum: ["metric", "imperial"] },
    },
    required: ["city"],
  },
  handler: async (args, ctx) => {
    if (!ctx.http) throw new Error("network:fetch missing");
    const res = await ctx.http.fetch(`https://wttr.in/${args.city}?format=j1`);
    return await res.json();
  },
});
```

Register at module-load time (top-level scope of your plugin's
sandbox entry, not inside a handler) so the tool is available before
the first OpenRouter chat call.

**Trusted-mode constraint:** the registry is a module-scoped
singleton — it works for plugins co-running in the same process.
Sandboxed plugins each get their own copy and therefore their own
(built-ins-only) registry. Same constraint as the
automations action registry.

## Routes

```
GET   /_emdash/api/plugins/tools/tools.list                     names + descriptions
GET   /_emdash/api/plugins/tools/tools.get?name=                full schema
GET   /_emdash/api/plugins/tools/tools.openaiSpec?agent_id=     OpenAI-compatible filtered spec
POST  /_emdash/api/plugins/tools/tools.invoke                   { name, arguments, taskId? }
GET   /_emdash/api/plugins/tools/invocations.list?tool=&task_id=
```

`tools.openaiSpec` is the endpoint OpenRouter's chat loop hits at
the top of every completion to populate the `tools` field in the
request. With `agent_id`, the catalog is filtered to that agent's
`tools[]` allowlist (see Agents plugin); with `allow=t1,t2,t3`, the
catalog is filtered to that explicit set; with neither, all
registered tools are returned.

`tools.invoke` is what OpenRouter calls back into when the model
returns a `tool_call`. Pass `taskId` to attribute the invocation to
the task — the Tools plugin will append a `[tool-call]` comment to
the task's activity log.

## Per-agent allowlist

```json
// Agent record in @emdash-cms/plugin-agents
{
  "id": "writer-bot",
  "tools": ["content_get", "content_search", "task_advance", "memory_search", "memory_put"]
}
```

OpenRouter calls `tools.openaiSpec?agent_id=writer-bot` and gets
only those five tools. The model can't even attempt to call tools
outside the allowlist.

If `agent.tools` is empty, all registered tools are available — fine
for trusted human-driven runs, locked down for autonomous agents.

## Audit

Every invocation is recorded in plugin storage (`invocations` collection)
with id, tool name, args, output (or error), duration, and the task
id (if any). The admin page at **Settings → Tools** shows the
registered catalog and recent invocations.

When `taskId` is supplied, the plugin also POSTs a comment to the
Task's activity log so end-to-end provenance flows: which agent ran
which tool with which args at what cost.

## Roadmap

- Streaming tool execution (some MCP tools are slow; consider
  long-poll or SSE)
- Per-tool capability gates enforced before invocation (currently
  advisory)
- Bridge to emdash's MCP catalog (re-export the 33 core tools as
  registry entries so we don't reimplement them)
- Tool-call activity becomes its own Tasks-plugin route so we don't
  smuggle tool calls into the comment log
