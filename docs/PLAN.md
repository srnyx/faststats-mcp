# FastStats MCP server — plan

A local stdio MCP server that Claude Desktop launches. It lets Claude inspect a FastStats project and design, validate and publish charts and dashboards through the public v0 API. Schema details are in [FLOW_SCHEMA.md](FLOW_SCHEMA.md).

## Stack

- **TypeScript on Node 22 LTS or newer**, using the official `@modelcontextprotocol/sdk` with stdio transport.
- **zod** for tool input schemas. The SDK turns these into the JSON Schema Claude sees, and they also do runtime validation.
- **Hand-written zod models** in `src/api/types.ts` for the endpoints the server uses, called with native `fetch`. Responses are parsed loosely, so new fields never break anything. `npm run test:contract` compares the hard-coded enums with the live OpenAPI spec. *(Changed from the original plan to generate types with openapi-typescript: the build sandbox couldn't reach api.faststats.dev, and runtime validation is worth having anyway.)*
- **tsup** bundles everything into a single `dist/index.js`. **vitest** runs the tests.
- Logging goes to **stderr only**, because stdout is the MCP channel.

## Configuration

`%APPDATA%\Claude\claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "faststats": {
      "command": "node",
      "args": ["C:\\path\\to\\faststats-mcp\\dist\\index.js"],
      "env": { "FASTSTATS_API_KEY": "fs_..." }
    }
  }
}
```

Optional environment variables: `FASTSTATS_BASE_URL` (default `https://api.faststats.dev`), `FASTSTATS_DEFAULT_PROJECT`, and `FASTSTATS_READ_ONLY=true`, which hides all mutating tools.

## Key design decision: a simple spec instead of raw flows

Claude never writes node ids, edges or canvas positions. Tools take a **series spec**, and the server compiles it into the `flow` graph, using the same id convention as the UI (`<type>-<series>-<step>`) and laying nodes out on the editor canvas:

```jsonc
{
  "name": "Deaths by cause",
  "chartType": "pie",
  "series": [
    { "name": "Servers",
      "steps": [
        { "datasource": "config_death_causes" },          // dedupe:true by default
        { "maxAge": "30m" },                               // shorthand → {value:30, unit:"m"}
        { "groupBy": "config_death_causes" },
        { "aggregate": "count" },
        { "limit": 8, "groupOthers": true }
      ],
      "result": { "splitPattern": null, "iconSetId": null } }
  ],
  // or, for ratios:
  "formula": { "expression": "A / B", "precision": 2, "inputs": [ /* series A */, /* series B */ ] },
  "visual": { "pie": { "style": "donut", "showTotal": true } },
  "size": "auto"   // or {w,h}; picked per chart type from the observed defaults
}
```

The compiler validates field names against the project's data sources and the internal fields for its project type, and checks enums. It returns friendly errors before anything is sent to FastStats.

## Tools

| Tool | Purpose | Mutates |
|---|---|---|
| `list_projects` | Slug, name and id for every project (paginated) | – |
| `get_project_context` | **One call with everything needed to design charts:** custom metrics (referenceId, type, shape), internal fields for the project type, dashboards, and a short summary of existing charts | – |
| `get_chart` | Full chart, with the flow decompiled back into a series spec for editing | – |
| `preview_chart` | Compiles the spec, calls `/metrics/preview`, returns validity, output names and a trimmed data sample | – |
| `create_chart` | Previews first and **refuses to save on failure or empty outputs**. Places the chart on the dashboard grid automatically (next free slot in 12 columns) | ✔ |
| `update_chart` | Patch by spec or by individual fields, using `expectedUpdatedAt` so it never overwrites a newer UI edit | ✔ |
| `delete_chart` | Requires `confirm: true` | ✔ |
| `create_dashboard` | New dashboard, optionally with a batch of chart specs that are previewed and laid out together | ✔ |
| `list_event_markers` / `create_event_marker` | Release markers to overlay on time-series charts | ✔ (create) |

There is also a `get_guide` tool, mirrored as the `faststats://guide` resource. Claude Desktop doesn't let the model read resources on its own, so the guide is exposed as a tool too.

## Project layout

```
faststats-mcp/
  package.json, tsconfig.json, tsup.config.ts
  src/
    index.ts                 // stdio server bootstrap and tool registration
    config.ts                // env parsing (API key, base URL, read-only)
    api/types.ts             // zod models + enums (from the OpenAPI spec)
    api/client.ts            // fetch client, auth header, error mapping, retry on 429/5xx
    flow/spec.ts             // zod schema for the series spec (the tool input)
    flow/compile.ts          // spec → flow (+ validation)
    flow/decompile.ts        // flow → spec (for get/update)
    flow/fields.ts           // internal fields per project type, plus custom metrics
    layout/grid.ts           // 12-col bin-packing with default sizes per type
    service.ts               // project/dashboard resolution, preview + validation, placement
    tools/index.ts           // all tool registrations
    resources/guide.md       // returned by get_guide; also exposed as faststats://guide
  test/                      // compile/decompile round-trips (fixtures = the 24 default charts), layout, enum validation
```

## Status

| Milestone | Status |
|---|---|
| 1. Skeleton (npm, SDK bootstrap, `list_projects`, stderr logging) | ✅ |
| 2. Read path (`get_project_context`, `get_chart` + decompiler, round-trip of the 12 default charts) | ✅ |
| 3. Compiler + `preview_chart` (+ tests) | ✅ verified against the live API |
| 4. Write path (`create_chart`, `update_chart`, `delete_chart`, grid placement, `create_dashboard`) | ✅ tested against a mock API |
| 5. Probe untested chart types (heatmap, radar, scatter, treemap, table) on a project with data | ⏳ |
| 6. Event markers, read-only mode, README | ✅ |

## Safety

- Every write is previewed first, so nothing invalid gets saved.
- Deleting needs an explicit `confirm`. Updates use optimistic locking.
- New charts go on a dashboard I create, e.g. "Claude — <topic>", unless you name an existing one. That way the default dashboard isn't touched by accident.
- The API key is read only from the environment. It is never logged or returned in tool output.

## Remaining

- Milestone 5 needs a project with recent data.
- The first real create/update calls with an API key. The write path has only run against a mock API so far.
