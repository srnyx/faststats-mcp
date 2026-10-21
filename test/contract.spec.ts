// Network test: run with `npm run test:contract`. Compares the enums this
// server hard-codes with the live FastStats OpenAPI spec, so API drift shows
// up as a failing test instead of a confusing tool error.
import { describe, expect, it } from "vitest";
import { CHART_TYPES, DATA_SOURCE_TYPES, DOWNLOAD_PROVIDERS, ERROR_PRIORITIES, ERROR_RESOLVE_MODES, ERROR_STATUSES, MARKER_GROUPINGS, MARKER_VISIBILITIES, METRIC_SHAPES, VisualOptions } from "../src/api/types";

type Schema = { anyOf?: Schema[]; enum?: string[]; properties?: Record<string, Schema>; $ref?: string };

const unwrap = (s: Schema | undefined): Schema | undefined => {
  if (!s) return s;
  if (s.anyOf) return unwrap(s.anyOf.find((x) => x.properties || x.enum) ?? s.anyOf[0]);
  return s;
};

describe("FastStats OpenAPI contract", async () => {
  const spec = (await (await fetch("https://api.faststats.dev/openapi.json")).json()) as {
    paths: Record<string, Record<string, { requestBody?: { content: Record<string, { schema: Schema }> } }>>;
  };
  const body = spec.paths["/v0/projects/{idOrSlug}/charts"]?.post?.requestBody?.content["application/json"]?.schema;

  it("chart create endpoint still exists", () => expect(body?.properties).toBeDefined());

  it("chart types match", () => {
    expect([...(unwrap(body?.properties?.chartType)?.enum ?? [])].sort()).toEqual([...CHART_TYPES].sort());
  });

  it("visual option groups match", () => {
    const vo = unwrap(unwrap(body?.properties?.queryConfig)?.properties?.visualOptions);
    expect(Object.keys(vo?.properties ?? {}).sort()).toEqual(Object.keys(VisualOptions.shape).sort());
  });

  it("data source enums match", () => {
    const ds = spec.paths["/v0/projects/{idOrSlug}/data-sources"]?.post?.requestBody?.content["application/json"]?.schema;
    expect([...(unwrap(ds?.properties?.dataType)?.enum ?? [])].sort()).toEqual([...DATA_SOURCE_TYPES].sort());
    expect([...(unwrap(ds?.properties?.metricShape)?.enum ?? [])].sort()).toEqual([...METRIC_SHAPES].sort());
  });

  it("data source endpoints still exist", () => {
    expect(spec.paths["/v0/projects/{idOrSlug}/data-sources/coverage"]?.get).toBeDefined();
    expect(spec.paths["/v0/projects/{idOrSlug}/data-sources/structured-fields"]?.get).toBeDefined();
    expect(spec.paths["/v0/projects/{idOrSlug}/data-sources/{dataSourceId}"]?.patch).toBeDefined();
  });

  it("marker collection enums match", () => {
    const mc = spec.paths["/v0/projects/{idOrSlug}/event-marker-collections/{collectionId}"]?.patch?.requestBody?.content["application/json"]?.schema;
    expect([...(unwrap(mc?.properties?.grouping)?.enum ?? [])].sort()).toEqual([...MARKER_GROUPINGS].sort());
    expect([...(unwrap(mc?.properties?.visibility)?.enum ?? [])].sort()).toEqual([...MARKER_VISIBILITIES].sort());
  });

  it("download providers match", () => {
    const dp = spec.paths["/v0/projects/{idOrSlug}/download-providers"]?.post?.requestBody?.content["application/json"]?.schema;
    expect([...(unwrap(dp?.properties?.provider)?.enum ?? [])].sort()).toEqual([...DOWNLOAD_PROVIDERS].sort());
  });

  it("dashboard, marker, anomaly and download endpoints still exist", () => {
    for (const [path, method] of [
      ["/v0/projects/{idOrSlug}/dashboards/{dashboardId}", "delete"],
      ["/v0/projects/{idOrSlug}/dashboards/{dashboardId}/duplicate", "post"],
      ["/v0/projects/{idOrSlug}/dashboards/{dashboardId}/copy", "post"],
      ["/v0/projects/{idOrSlug}/dashboards/order", "put"],
      ["/v0/projects/{idOrSlug}/event-marker-collections/{collectionId}/events/bulk", "post"],
      ["/v0/projects/{idOrSlug}/event-marker-collections/{collectionId}/events/{eventId}", "patch"],
      ["/v0/projects/{idOrSlug}/anomalies", "get"],
      ["/v0/projects/{idOrSlug}/check-data", "get"],
      ["/v0/projects/{idOrSlug}/downloads", "get"],
      ["/v0/projects/{idOrSlug}/download-providers/search", "get"],
    ] as const) expect(spec.paths[path]?.[method], `${method} ${path}`).toBeDefined();
  });

  it("error tracking enums match", () => {
    const q = spec.paths["/v0/errors/issues/query"]?.post?.requestBody?.content["application/json"]?.schema;
    expect([...(unwrap(q?.properties?.status)?.enum ?? [])].sort()).toEqual([...ERROR_STATUSES].sort());
    const meta = spec.paths["/v0/projects/{idOrSlug}/errors/issues/{errorId}"]?.patch?.requestBody?.content["application/json"]?.schema;
    expect([...(unwrap(meta?.properties?.priority)?.enum ?? [])].sort()).toEqual([...ERROR_PRIORITIES].sort());
    const resolve = spec.paths["/v0/errors/resolve"]?.post?.requestBody?.content["application/json"]?.schema;
    expect([...(unwrap(resolve?.properties?.mode)?.enum ?? [])].sort()).toEqual([...ERROR_RESOLVE_MODES].sort());
  });

  it("error tracking endpoints still exist", () => {
    for (const [path, method] of [
      ["/v0/projects/{idOrSlug}/errors/issues/query", "post"],
      ["/v0/errors/timeseries/query", "post"],
      ["/v0/projects/{idOrSlug}/errors/timeseries/query", "post"],
      ["/v0/projects/{idOrSlug}/errors/issues/{errorId}/occurrences", "get"],
      ["/v0/projects/{idOrSlug}/errors/issues/{errorId}/stacktrace-variants", "get"],
      ["/v0/projects/{idOrSlug}/errors/issues/{errorId}/labels", "put"],
      ["/v0/projects/{idOrSlug}/errors/filters", "get"],
      ["/v0/projects/{idOrSlug}/errors/labels", "get"],
      ["/v0/projects/{idOrSlug}/errors/resolutions/clear", "post"],
      ["/v0/projects/{idOrSlug}/errors/issues/viewed", "post"],
      ["/v0/projects/{idOrSlug}/errors/issues/merge", "post"],
      ["/v0/projects/{idOrSlug}/errors/issues/delete", "post"],
    ] as const) expect(spec.paths[path]?.[method], `${method} ${path}`).toBeDefined();
  });

  it("preview endpoint still exists", () => {
    expect(spec.paths["/v0/projects/{idOrSlug}/metrics/preview"]?.post).toBeDefined();
  });
});
