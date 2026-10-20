# FastStats for Claude

A [Claude Desktop](https://claude.ai/download) extension (MCP server) that lets Claude design, validate and publish [FastStats](https://faststats.dev) charts and dashboards for your projects.

Ask things like *"make a dashboard showing how servers configure my plugin"* and Claude will read your project's metrics, design the charts, test each one against your real data, and save them.

- **Nothing broken gets saved.** Every chart is checked against your project's fields and dry-run with FastStats' preview endpoint before it is created or updated.
- **Your edits are safe.** Updates never overwrite a chart that changed since Claude read it, and deleting needs explicit confirmation.
- **Read-only mode** hides every tool that writes, if you only want Claude to look.

## Install

1. Download **[faststats-mcp.mcpb](https://github.com/srnyx/faststats-mcp/releases/latest/download/faststats-mcp.mcpb)** from the latest release.
2. Double-click it, or drag it into Claude Desktop under **Settings → Extensions**, then click **Install**.
3. Paste a FastStats API key when asked (create one on faststats.dev under **Settings → API keys**). It's stored in your system keychain and only sent to FastStats.

That's it: no Node.js, cloning or building needed. Claude Desktop runs the extension with its built-in Node runtime.

### Settings

| Setting | |
|---|---|
| **FastStats API key** | Required. Only projects this key can access are visible to Claude. |
| **Default project** | Optional slug or id (e.g. `my-plugin`) used when you don't name a project. |
| **Read-only mode** | Hides create, update and delete tools. |

Change them any time under **Settings → Extensions → FastStats**.

## Tools

| Tool | Writes | |
|---|---|---|
| `get_guide` | | Spec format, step reference, semantics, recipes |
| `list_projects` | | Projects your key can access |
| `get_project_context` | | Fields (built-in and custom metrics), dashboards, charts |
| `get_chart` | | A chart as an editable spec |
| `preview_chart` | | Validates and dry-runs a spec, returns a data sample |
| `list_event_markers` | | Marker collections or their markers |
| `create_chart` | ✔ | Previews first. Auto-placed on a 12-column grid. |
| `update_chart` | ✔ | Previews first. Never overwrites newer edits made in the FastStats UI. |
| `delete_chart` | ✔ | Requires explicit confirmation |
| `create_dashboard` | ✔ | Optionally with charts. All are previewed before anything is created. |
| `create_event_marker` | ✔ | e.g. releases to overlay on time series |

## How charts are described

Claude writes charts in a compact **series spec** (datasource → filter → groupBy → aggregate …), and the extension compiles it into FastStats' flow graph:

```json
{
  "name": "Storage backends",
  "chartType": "pie",
  "outputs": [{
    "name": "Servers",
    "steps": [
      { "datasource": "internal:server_count" },
      { "groupBy": "storage.method" },
      { "aggregate": "count" },
      { "limit": 8, "groupOthers": true }
    ]
  }],
  "visual": { "pie": { "style": "donut", "showTotal": true } }
}
```

Nested keys of JSON metrics (like `storage.method` above) work as dot paths. See [`src/resources/guide.md`](src/resources/guide.md) for the full format and [`docs/FLOW_SCHEMA.md`](docs/FLOW_SCHEMA.md) for the reverse-engineered FastStats schema.

## Other MCP clients

The server is a single file, so any stdio MCP client can run it. Build it (see below), then point your client at `dist/index.js`:

```json
{
  "mcpServers": {
    "faststats": {
      "command": "node",
      "args": ["C:\\path\\to\\faststats-mcp\\dist\\index.js"],
      "env": { "FASTSTATS_API_KEY": "your-key" }
    }
  }
}
```

| env | default | |
|---|---|---|
| `FASTSTATS_API_KEY` | required | Sent as `x-api-key`. Never logged or returned. |
| `FASTSTATS_DEFAULT_PROJECT` | none | Slug or id used when a tool call omits `project`. |
| `FASTSTATS_READ_ONLY` | `false` | `true` hides every tool that writes. |
| `FASTSTATS_BASE_URL` | `https://api.faststats.dev` | |

## Development

Requires Node.js 22+.

```powershell
npm install
npm run build          # bundles to dist\index.js (self-contained)
npm test               # unit tests (compiler, round-trip on real charts, grid, client, manifest)
npm run test:contract  # checks hard-coded enums against the live OpenAPI spec
npm run typecheck
npm run pack           # build + validate manifest + create faststats-mcp.mcpb
npm run inspect        # MCP Inspector against dist\index.js
```

To try a local build in Claude Desktop, run `npm run pack` and install the resulting `faststats-mcp.mcpb`.

### Releasing

1. Bump `version` in both `package.json` and `manifest.json` (a test fails if they differ), and commit.
2. Publish a GitHub release whose tag is that version, e.g. `0.2.0` (no `v`).

GitHub Actions runs the checks, builds `faststats-mcp.mcpb` and attaches it to the release, so the download link above always points at the latest version.

## License

[MIT](LICENSE)
