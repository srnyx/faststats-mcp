# FastStats chart design guide

## Workflow

1. `get_project_context`: lists the fields (built-in `internal:*` and the plugin's custom metrics, with type and shape), the dashboards, and the existing charts.
2. Write a chart spec, then call `preview_chart`. Fix any errors and repeat until `ok: true`.
3. Publish. Use `create_dashboard` with `charts: [...]` for a whole dashboard, or `create_chart` with an existing `dashboard`.
4. To edit, call `get_chart`, change the returned `spec`, and pass it to `update_chart`.

## Spec format

```jsonc
{
  "name": "Players over time",
  "chartType": "area",                 // widget line area bar pie map list heatmap radar scatter treemap table
  "outputs": [                         // one per series / tab / value
    { "name": "Players",
      "steps": [
        { "datasource": "internal:player_count" },   // first step, always
        { "timeGroup": "hour" },                    // gapFill "zero" by default
        { "aggregate": "sum" }
      ] }
  ],
  "visual": { "line": { "lineType": "monotone" } },
  "size": { "w": 12, "h": 3 }          // optional; defaults per chart type
}
```

### Steps

| step | example |
|---|---|
| datasource | `{ "datasource": "config_death_causes" }` (dedupe defaults to true, one row per server) |
| filter | `{ "filter": { "field": "internal:online_mode", "op": "equals", "value": true } }` ops: equals, not_equals, contains, regex, regex_not, greater_than, less_than, greater_equal, less_equal. For map metrics add `"mapTarget": "key"` or `"value"`. |
| groupBy | `{ "groupBy": "internal:plugin_version" }` or `{ "groupBy": ["a","b"], "mode": "combined" }` |
| timeGroup | `{ "timeGroup": "day", "gapFill": "zero", "cumulative": false }` intervals: auto minute hour day week month |
| maxAge / minAge | `{ "maxAge": "30m" }` (30m = currently online). Units: ms s m h d |
| aggregate | `{ "aggregate": "count" }` count sum avg median min max distinct |
| limit | `{ "limit": 8, "groupOthers": true }` |
| sort | `{ "sort": "value", "direction": "desc" }` by: value dimension time |
| transform | `{ "transform": "replaceRegex", "pattern": "^(?:1\\.)?(\\d+).*$", "replacement": "\\1" }` |
| gapFill / dedupe | `{ "gapFill": "zero" }`, `{ "dedupe": "server_id" }` |
| raw | `{ "node": "<type>", "data": { ... } }`, an escape hatch that preserves unknown nodes |

Usual order: datasource → filter / maxAge → groupBy or timeGroup → aggregate → limit / sort / transform.

### Formulas

```jsonc
{ "name": "Players per server", "formula": "A / B", "precision": 2,
  "inputs": [
    { "steps": [ { "datasource": "internal:player_count" }, { "maxAge": "30m" }, { "aggregate": "sum" } ] },
    { "steps": [ { "datasource": "internal:server_count" }, { "maxAge": "30m" }, { "aggregate": "count" } ] }
  ] }
```

Inputs are named A, B, C… in order. Allowed operators are `+ - * /` and parentheses.

### Display (per output)

`{ "display": { "iconSetId": "builtin:os", "splitDataSource": "internal:os_version", "splitPattern": "{key}: {value}", "color": "#22c55e" } }`

## Semantics

- `internal:server_count` with `aggregate: count` counts servers. `internal:player_count` with `aggregate: sum` counts players.
- Custom metrics are reported per server. To show how many servers use each value, use `datasource` set to the metric, `groupBy` set to the same metric, then `aggregate: count`.
- Array metrics: each element counts separately under `groupBy`.
- Map metrics (shape `map`): use `groupBy` on the metric with `display.splitPattern` (`{key}`, `{value}`), or filter by key with `mapTarget: "key"`. Dot paths do not work on map metrics.
- JSON metrics (type `json`, e.g. a whole config object): address nested keys with a dot path, e.g. `datasource(internal:server_count) → groupBy(storage.cache.enabled) → aggregate(count)`. Dot paths also work in `filter.field`. Servers that don't report the key come back as an empty `""` group; relabel it with `{ "transform": "replaceRegex", "pattern": "^$", "replacement": "Not reported" }`.
- `map` charts need `groupBy: internal:country`.
- `list` charts with several outputs show one tab per output.
- The dashboard grid is 12 columns wide. Default sizes: widget 3×2, line/area 12×3, list/pie 4×4, bar 6×4, map 8×4.

## Design tips

- Lead with 3–4 `widget` KPIs across the top row (w 3 each).
- Pick charts by question: share → pie/donut or list, trend → area/line with `timeGroup`, ranking → horizontal bar, `limit` 10 with `groupOthers`.
- Use `visual.valueFormat` for units, and `thresholds` to mark goals.
- Overlay release markers on time series with `markerCollections` (see `list_event_markers`).

## Recipes

```
Total servers      datasource(internal:server_count) → aggregate(count)
Online servers     datasource(internal:server_count) → maxAge(30m) → aggregate(count)
Online players     datasource(internal:player_count) → maxAge(30m) → aggregate(sum)
Breakdown          datasource(internal:server_count) → groupBy(<field>) → aggregate(count)
Over time          datasource(...) → timeGroup(hour) → aggregate(...)   (one output per series)
Java major         ... groupBy(internal:java_version) → aggregate(count) → transform(replaceRegex "^(?:1\.)?(\d+).*$" → "\1")
Feature adoption   datasource(<metric>) → groupBy(<metric>) → aggregate(count) → limit(10, groupOthers)
```
