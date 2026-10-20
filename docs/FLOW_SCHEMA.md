# FastStats chart schema (reverse-engineered)

Sources: `https://api.faststats.dev/openapi.json` (v0.0.1), the web app's `charts-*.js` bundle (Effect Schema definitions), live `GET /charts` on `limited-lives`, and dry-run `POST /metrics/preview` probes. Verified 2026-10-19.

## API basics

- Base URL: `https://api.faststats.dev`, all routes under `/v0`.
- Auth: header `x-api-key: <key>` **or** `Authorization: Bearer <key>`. Keys are created in user/org settings.
- Projects addressed by `{idOrSlug}` (e.g. `limited-lives`). `GET /v0/projects` → `{items, total, limit, offset, hasMore}`.
- Every project has a virtual default dashboard with id `default:<projectUuid>`.
- API is v0, with no fixed rate limits yet. Breaking changes are possible.

## Chart object

```jsonc
{
  "name": "Online Players",          // required
  "chartType": "widget",             // required: widget|line|area|bar|pie|map|list|heatmap|radar|scatter|treemap|table
  "query": { "type": "flow", "nodes": [...], "edges": [...] },  // required
  "dashboardId": "uuid | default:<projectUuid> | null",
  "description": "string | null",
  "position": { "x": 0, "y": 0, "w": 3, "h": 2 },   // 12-column grid
  "queryConfig": { "groupLimit": 10, "visualOptions": {...}, "markerCollections": [...] }
}
```

Unknown top-level fields are rejected (`additionalProperties: false`). `PATCH` accepts any subset plus `expectedUpdatedAt` (optimistic lock → 409 `ChartConflictError`).

### Observed default layout (12-col grid)

| Use | w × h |
|---|---|
| Stat widget | 3 × 2 |
| Full-width time series | 12 × 3 |
| List / small bar | 4 × 4 |
| Half-width list/bar | 6 × 4 |
| Map | 8 × 4 |

## Flow graph

- `nodes[]`: `{ id, type, data, position? }`, where `position` is the editor canvas position and is optional.
- Edge ids in stored charts are always `edge-<source>-<target>`.
- `edges[]`: `{ id, source, target }`.
- Each **series** is a linear chain that ends in a `result` node. Multiple chains mean multiple series (line/area) or tabs (list).
- The UI's id convention is `<type>-<seriesIndex>-<stepIndex>`, e.g. `groupBy-1-1`.
- Node type aliases accepted: `group`/`groupby` → `groupBy`, `time_group` → `timeGroup`, `min_age` → `minAge`, `max_age` → `maxAge`, `row_limit` → `limit`, `text_transform` → `textTransform`, `gap_fill` → `gapFill`.

### Node types and `data`

| type | data | notes |
|---|---|---|
| `datasource` | `{ datasource, dedupe?, dedupeIdentity?, dataTypeOverride? }` | `datasource` = an `internal:*` field or a custom metric's `referenceId`. `dedupeIdentity`: `user_id\|server_id\|version_id\|project`. Default charts always use `dedupe: true`. |
| `filter` | `{ field, operator, value, dataType?, mapFilterTarget? }` | operators: `equals, not_equals, contains, regex, regex_not, greater_than, less_than, greater_equal, less_equal`. `dataType`: `string\|number\|boolean\|datetime`. `mapFilterTarget`: `key\|value`, used for map metrics. `value` is a string. |
| `aggregate` | `{ function }` | `count, sum, avg, median, min, max, distinct` |
| `groupBy` | `{ field }` or `{ fields[], mode }` | `mode`: `combined\|flat` |
| `timeGroup` | `{ interval, gapFill?, cumulative? }` | interval: `auto, minute, hour, day, week, month`. gapFill: `zero\|none` |
| `minAge` / `maxAge` | `{ value, unit }` | unit: `ms, s, m, h, d`. `maxAge 30m` = "currently online" |
| `limit` | `{ limit, groupOthers? }` | `groupOthers` buckets the rest as "Other" |
| `sort` | `{ by, direction }` | by: `value\|dimension\|time`, direction: `asc\|desc` |
| `gapFill` | `{ mode }` | `zero\|none` |
| `dedupe` | `{ identity }` | same enum as `dedupeIdentity` |
| `textTransform` | `{ transform, pattern?, replacement? }` | `toLowerCase, toUpperCase, toTitleCase, trim, append, replace, replaceRegex, length` |
| `formula` | `{ formula, outputName?, precision? }` | Several chains feed one formula node. Inputs are named **A, B, C…** in edge order (case-insensitive). ⚠ An unknown variable silently produces **zero outputs**, with no error. |
| `result` | `{ outputName, iconSetId?, color?, colors?, splitPattern?, splitDataSource?, splitByCustomPattern? }` | `iconSetId` e.g. `builtin:os`. `splitDataSource` drills into a secondary field (OS Name → `internal:os_version`). `splitPattern` e.g. `{key}: {value}` for map metrics. |

### Fields

**Minecraft plugin internals:** `server_id`, `player_count` (number), `server_count` (number), `online_mode` (bool), `client` (bool), `plugin_version`, `game_version`, `minecraft_version`, `server_type` (shown as "Platform"), `platform_version`, `java_version`, `java_vendor`, `os_name`, `os_version`, `os_arch`, `core_count` (number). All prefixed `internal:`.

**All projects:** `internal:country`, `internal:created_at` (datetime).

**Custom metrics:** from `GET /v0/projects/{p}/data-sources`, referenced by `referenceId`. Each has `dataType` (string/number/boolean), `metricShape` (`scalar | array | map`), and `isArray`. Unknown fields → HTTP 500 `"Field 'x' is not available for this dataset"`.

## Canonical recipes (copied from the default dashboard)

```
Total servers      datasource(server_count) → aggregate(count) → result
Online servers     datasource(server_count) → maxAge(30m) → aggregate(count) → result
Online players     datasource(player_count) → maxAge(30m) → aggregate(sum) → result
Breakdown list     datasource(server_count) → groupBy(<field>) → aggregate(count) → result
Over time          datasource(...) → timeGroup(hour, gapFill zero) → aggregate(...) → result   (one chain per series)
Java major ver     ... groupBy(java_version) → aggregate(count) → textTransform(replaceRegex "^(?:1\.)?(\d+).*$" → "\1") → result
Ratio              [chain A] + [chain B] → formula("A / B", precision 2) → result
```

## queryConfig.visualOptions

`colors[]`, `thresholds[{value,label,color}]`, `valueFormat{unit: number|percent|percent_ratio|duration_ms|duration_s|bytes|custom, customUnit, decimals}`, `valueAxis{min,max}`, plus per-type blocks:

- `pie{style: pie|donut, showLegend, showTotal, showLabels, totalDisplayMode: sum|count, drilldown{enabled, splitPattern}}`
- `bar{logarithmic, stacked, orientation: vertical|horizontal}`
- `line{logarithmic, lineType: monotone|linear|step, showDots}`
- `widget{showTrend, displayMode: default|compact, valueFormat: number|percent|duration_ms}`
- `list{selectedTabIndex, splitPattern, multiMetric}`
- `heatmap{showLegend}`
- `radar{logarithmic, showDots, fillOpacity, showLegend, gridType: polygon|circle}`
- `scatter{logarithmic, pointSize: small|medium|large, showLegend}`
- `table{showBars, showTotals}`

`markerCollections[{collectionId, enabled, display{icon, emoji, color}}]` overlays event markers (e.g. release dates).

## Validation endpoint

`POST /v0/projects/{p}/metrics/preview` with `{chartType, queryConfig, query}` runs the flow without saving. It returns `data` and `flowMeta.outputs[]`. Treat it as valid only when the status is 200 **and** `outputs.length` equals the number of `result` nodes.

## Still unverified

- Exact `data` shape returned per chart type (needs a project with recent data).
- `heatmap`, `radar`, `scatter`, `treemap`, `table` flows: none exist in the defaults, so their axis/series expectations are untested.
- Operators listed in the AST (`startsWith`, `in`, `between`, `isNull`, …) have no UI labels, and it's unclear whether the flow `filter` node accepts them.
- The UI chart export/import JSON wrapper, which may not be needed since the API takes the chart object directly.

## Verified against the live API (2026-10-19)

These compiler outputs were accepted by `/metrics/preview` with the expected outputs:

- pie: custom array metric → groupBy → count → limit(groupOthers) → sort
- widget: two-input formula `A / B` with `maxAge`
- list with two tabs: a map metric filtered with `mapFilterTarget: "key"` plus `splitPattern`, and a boolean filter → cumulative daily `timeGroup`

A list output that has a `timeGroup` returns `data.tabs[i]` as `[{name, bucket, value}]`.
