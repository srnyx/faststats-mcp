# faststats-mcp: notes for Claude

A local stdio MCP server (TypeScript, Node 22+, `@modelcontextprotocol/sdk` + zod v4), distributed as a Claude Desktop extension (`faststats-mcp.mcpb`, built from `manifest.json` + `dist/index.js`) via GitHub Releases. The user is on Windows; give PowerShell commands.

## Architecture

- `src/api/types.ts`: hand-written zod models and enums for the FastStats v0 API. Responses use `z.looseObject`. When FastStats changes the API, update these and run `npm run test:contract`.
- `src/api/client.ts`: fetch wrapper (x-api-key, retries on 429/502/503/504, error mapping). It redacts `token`, `codeContextConfig` and `owner` from project objects. Never return those.
- `src/flow/spec.ts`: the series-spec input format (zod). Steps are a union of strict objects told apart by their keys. Keep keys unique per step type.
- `src/flow/compile.ts`: spec → flow. Node ids follow the UI convention `<type>-<output>-<step>`, edges `edge-<src>-<tgt>`. Formula inputs are `<type>-<output>-<input>-<step>`, and **edge order into a formula node defines A, B, C…**.
- `src/flow/decompile.ts`: flow → spec. Any node that doesn't re-compile to identical data becomes a raw `{ node, data }` step, so round-trips are lossless.
- `src/service.ts`: project/dashboard/marker-collection/data-source resolution (`resolveStoredDashboard` refuses the synthetic `default:<id>` dashboard for renames/deletes), `chartsUsing` (charts referencing a metric, used to guard data source renames/deletes), preview (compile errors → API preview → output-count check), grid placement.
- `src/tools/index.ts`: tool registrations (charts, dashboards, markers, data sources, health, downloads). Write tools are skipped when `FASTSTATS_READ_ONLY`.
- `src/tools/errors.ts`: error-tracking tools. `list_errors` filters "new/regressed since" locally on `firstOccurred`/`lastOccurred`, so it stays correct even if the API's `from`/`to` units differ. Unverified: `from`/`to` are sent as Unix ms, and `{errorId}` path params take the issue's `errorId` field (not `id`). Known (2026-10-20): `POST /errors/issues/query` answers 403 "User session required" to API keys even though the spec lists `apiKeyAuth`; `GET /errors/filters` works with a key. The other error endpoints are still unchecked.
- `src/tools/util.ts`: shared `ok`/`fail`/`guard`/`projectArg`/`defined` helpers.
- `src/schema.ts`: `withPortableToolSchemas` wraps the transport and rewrites `"type": [...]` (what zod v4 emits for bare-type unions and `.nullable()`) into `anyOf` in `tools/list`, for clients like Gemini. `test/schema.test.ts` lists every tool through the real SDK and fails on any type array.
- `src/resources/guide.md`: returned by `get_guide`. Keep it in sync with spec.ts.
- `docs/FLOW_SCHEMA.md`: reverse-engineered schema notes and what's still unverified.
- `manifest.json`: MCPB manifest. `user_config` (API key, default project, read-only) maps to the env vars read by `src/config.ts`. Its `version` and `tools` must match `package.json` and the registered tools (`test/manifest.test.ts`).
- `.mcpbignore`: explicit exclude list (negated patterns don't work). Only `dist/index.js`, the manifest, icon, LICENSE and README are packed.
- `.github/workflows/`: `ci.yml` checks and packs on push/PR; `release.yml` runs on every published GitHub release and attaches the `.mcpb`; the release tag must equal the version (no `v`).

## Rules

- stdout is the MCP channel: log only via `src/log.ts` (stderr).
- Every chart write must go through `svc.preview` first, and must not save when `ok` is false. Data source writes have no preview; renaming a referenceId or deleting a metric must check `svc.chartsUsing` and refuse without `force`.
- FastStats silently returns zero outputs for bad formula variables, which is why preview compares the output count with the number of result nodes.
- `test/fixtures/default-dashboard.json` holds the real stored flows of the 12 default Minecraft charts. The round-trip test must stay green.
- Dot paths (`storage.cache.enabled`) are valid only on custom metrics with dataType `json`; map metrics return a 500 for them (`FieldCatalog.jsonPathRoot`).
- Adding or renaming a tool: update `manifest.json` `tools` and the README table too.
- Every delete tool takes `confirm: z.literal(true)` and is marked `destructiveHint`.
- Before finishing a change: `npm run typecheck && npm test && npm run pack`.
