import { describe, expect, it } from "vitest";
import { registerTools } from "../src/tools/index";
import { LIMITED_LIVES_SOURCES, toolHarness } from "./helpers";

const CHART = {
  id: "c1",
  projectId: "p1",
  dashboardId: "default:p1",
  name: "Storage",
  chartType: "pie",
  query: {
    type: "flow",
    nodes: [
      { id: "datasource-0-0", type: "datasource", data: { datasource: "internal:server_count" } },
      { id: "groupBy-0-1", type: "groupBy", data: { field: "storage.method" } },
    ],
    edges: [],
  },
};

function setup(charts: unknown[] = [CHART]) {
  return toolHarness({
    "GET /v0/projects/p1/data-sources": () => LIMITED_LIVES_SOURCES,
    "GET /v0/projects/p1/data-sources/coverage": () => ({
      fromTime: 1, toTime: 2, totalEvents: 100,
      sources: [{ referenceId: "storage", eventCount: 80, percentage: 80 }, { referenceId: "new_metric", eventCount: 5, percentage: 5 }],
    }),
    "GET /v0/projects/p1/data-sources/structured-fields": () => ({
      fields: [{ sourceReferenceId: "storage", path: ["cache", "enabled"], dataType: "boolean", observedTypes: ["boolean"], observedCount: 70, firstSeenAt: null, lastSeenAt: null, sampleValue: "true" }],
    }),
    "GET /v0/projects/p1/charts": () => charts,
    "POST /v0/projects/p1/data-sources": (b) => ({ id: "new", ...(b as object) }),
    "PATCH /v0/projects/p1/data-sources/ds-12": (b) => ({ ...LIMITED_LIVES_SOURCES[12], ...(b as object) }),
    "DELETE /v0/projects/p1/data-sources/ds-12": () => undefined,
  });
}

describe("data source tools", () => {
  it("lists sources with coverage, unregistered keys and observed json paths", async () => {
    const { call } = setup();
    const { data } = await call("list_data_sources", { coverage: true, structuredFields: true });
    const storage = data.sources.find((s: { referenceId: string }) => s.referenceId === "storage");
    expect(storage).toMatchObject({ eventCount: 80, percentage: 80, fields: [{ path: "storage.cache.enabled", dataType: "boolean", sample: "true" }] });
    expect(data.sources.find((s: { referenceId: string }) => s.referenceId === "config").eventCount).toBe(0);
    expect(data.coverage).toMatchObject({ totalEvents: 100, unregistered: [{ referenceId: "new_metric" }] });
  });

  it("omits coverage and fields unless asked", async () => {
    const { data } = await setup().call("list_data_sources", {});
    expect(data.coverage).toBeUndefined();
    expect(data.sources[0]).not.toHaveProperty("fields");
  });

  it("creates with scalar shape by default and rejects duplicate referenceIds", async () => {
    const { call, writes } = setup();
    const created = await call("create_data_source", { name: "New", referenceId: "new_metric", dataType: "number", minValue: 0 });
    expect(created.isError).toBe(false);
    expect(writes()[0]!.body).toEqual({ name: "New", referenceId: "new_metric", dataType: "number", minValue: 0, metricShape: "scalar" });

    const dup = await call("create_data_source", { name: "Dup", referenceId: "storage", dataType: "string" });
    expect(dup.isError).toBe(true);
    expect(writes()).toHaveLength(1);
  });

  it("updates by referenceId and keeps the current metricShape", async () => {
    const { call, writes } = setup();
    const r = await call("update_data_source", { dataSource: "storage", description: "Storage config" });
    expect(r.isError).toBe(false);
    expect(writes()[0]).toMatchObject({ method: "PATCH", path: "/v0/projects/p1/data-sources/ds-12", body: { description: "Storage config", metricShape: "map" } });
  });

  it("refuses to rename a referenceId that charts use, unless forced", async () => {
    const { call, writes } = setup();
    const refused = await call("update_data_source", { dataSource: "storage", referenceId: "storage2" });
    expect(refused.isError).toBe(true);
    expect(refused.data.charts).toEqual([{ id: "c1", name: "Storage", dashboardId: "default:p1" }]);
    expect(writes()).toHaveLength(0);

    const forced = await call("update_data_source", { dataSource: "storage", referenceId: "storage2", force: true });
    expect(forced.isError).toBe(false);
    expect(forced.data.warnings[0]).toMatch(/Storage/);
  });

  it("refuses to delete a metric that charts use, unless forced", async () => {
    const { call, writes } = setup();
    expect((await call("delete_data_source", { dataSource: "storage", confirm: true })).isError).toBe(true);
    expect(writes()).toHaveLength(0);
    const forced = await call("delete_data_source", { dataSource: "storage", confirm: true, force: true });
    expect(forced.data).toMatchObject({ deleted: "ds-12", brokenCharts: [{ id: "c1" }] });
  });

  it("does not treat a shared name prefix as a reference", async () => {
    // "storage_cache_save_on" must not count as using "storage", nor "storage.method" as using "storage_cache_save_on".
    const { call, writes } = setup([{ ...CHART, query: { ...CHART.query, nodes: [{ id: "n", data: { field: "storage_cache_save_on" } }] } }]);
    expect((await call("delete_data_source", { dataSource: "storage", confirm: true })).isError).toBe(false);
    expect(writes()).toMatchObject([{ method: "DELETE", path: "/v0/projects/p1/data-sources/ds-12" }]);
  });

  it("reports unknown data sources", async () => {
    const r = await setup().call("delete_data_source", { dataSource: "nope", confirm: true });
    expect(r.isError).toBe(true);
    expect(r.data.error).toMatch(/not found/);
  });

  it("hides data source writes in read-only mode", () => {
    const names: string[] = [];
    registerTools({ registerTool: (n: string) => names.push(n) } as never, {} as never, { readOnly: true });
    expect(names).toContain("list_data_sources");
    expect(names).not.toContain("delete_data_source");
  });
});
