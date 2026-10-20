import { describe, expect, it } from "vitest";
import { toolHarness } from "./helpers";

const dash = (id: string, name: string, position: number, isDefault = false) => ({ id, projectId: "p1", name, description: null, isPublic: false, isDefault, position });
const DASHBOARDS = [dash("d0", "Overview", 0, true), dash("d1", "Config", 1), dash("d2", "Players", 2), dash("d3", "Storage", 3)];

const chart = (id: string, dashboardId: string, queryConfig: unknown = null) => ({
  id, projectId: "p1", dashboardId, name: `Chart ${id}`, chartType: "pie", queryConfig,
  query: { type: "flow", nodes: [], edges: [] },
});

const COLLECTIONS = [{ id: "mc1", name: "Releases" }];
// The API always returns timestamps as strings, whatever form they were sent in.
const marker = (b: Record<string, unknown>, i = 0) => ({ id: `ev${i}`, collectionId: "mc1", ...b, timestamp: String(b.timestamp) });

describe("dashboard tools", () => {
  const setup = () =>
    toolHarness({
      "GET /v0/projects/p1/dashboards": () => DASHBOARDS,
      "GET /v0/projects/p1/charts": (_b, q) => [chart("c1", "d1"), chart("c2", "d2")].filter((c) => !q.dashboardId || c.dashboardId === q.dashboardId),
      "PATCH /v0/projects/p1/dashboards/d1": (b) => ({ ...DASHBOARDS[1], ...(b as object) }),
      "DELETE /v0/projects/p1/dashboards/d1": () => undefined,
      "POST /v0/projects/p1/dashboards/d1/duplicate": () => dash("d9", "Config (copy)", 4),
      "POST /v0/projects/p1/dashboards/d1/copy": () => ({ ...dash("d9", "Config", 0), projectId: "p2" }),
      "PUT /v0/projects/p1/dashboards/order": () => undefined,
    });

  it("updates by name and sends only the changed fields", async () => {
    const { call, writes } = setup();
    const r = await call("update_dashboard", { dashboard: "config", isPublic: true });
    expect(r.data.updated).toMatchObject({ id: "d1", isPublic: true });
    expect(writes()).toMatchObject([{ method: "PATCH", path: "/v0/projects/p1/dashboards/d1", body: { isPublic: true } }]);
  });

  it("refuses to change or delete the default dashboard", async () => {
    const { call, writes } = setup();
    expect((await call("update_dashboard", { dashboard: "default", name: "x" })).isError).toBe(true);
    expect((await call("delete_dashboard", { dashboard: "Overview", confirm: true })).isError).toBe(true);
    expect(writes()).toHaveLength(0);
  });

  it("rejects an update with nothing to change", async () => {
    expect((await setup().call("update_dashboard", { dashboard: "d1" })).isError).toBe(true);
  });

  it("deletes and reports the charts that were on it", async () => {
    const { call, writes } = setup();
    const r = await call("delete_dashboard", { dashboard: "Config", confirm: true });
    expect(r.data).toEqual({ deleted: "d1", name: "Config", chartsOnIt: ["Chart c1"] });
    expect(writes()).toMatchObject([{ method: "DELETE", path: "/v0/projects/p1/dashboards/d1" }]);
  });

  it("duplicates in place, and copies when targetProject differs", async () => {
    const { call, writes } = setup();
    expect((await call("duplicate_dashboard", { dashboard: "Config" })).data.created).toEqual({ id: "d9", name: "Config (copy)", project: "p1" });
    expect((await call("duplicate_dashboard", { dashboard: "Config", targetProject: "p1" })).data.note).toBeUndefined();
    const copied = await call("duplicate_dashboard", { dashboard: "Config", targetProject: "p2" });
    expect(copied.data.created.project).toBe("p2");
    expect(copied.data.note).toMatch(/data sources/);
    expect(writes().map((w) => w.path)).toEqual([
      "/v0/projects/p1/dashboards/d1/duplicate",
      "/v0/projects/p1/dashboards/d1/duplicate",
      "/v0/projects/p1/dashboards/d1/copy",
    ]);
    expect(writes()[2]!.body).toEqual({ targetProjectId: "p2" });
  });

  it("reorders listed dashboards first, keeps the rest after, and leaves the default slot alone", async () => {
    const { call, writes } = setup();
    const r = await call("reorder_dashboards", { order: ["Storage", "d1"] });
    expect(r.data.order).toEqual(["Storage", "Config", "Players"]);
    expect(writes()[0]!.body).toEqual({ dashboards: [{ id: "d3", position: 1 }, { id: "d1", position: 2 }, { id: "d2", position: 3 }] });
  });

  it("rejects duplicates and unknown names when reordering", async () => {
    const { call, writes } = setup();
    expect((await call("reorder_dashboards", { order: ["Storage", "storage"] })).isError).toBe(true);
    expect((await call("reorder_dashboards", { order: ["Nope"] })).isError).toBe(true);
    expect(writes()).toHaveLength(0);
  });
});

describe("event marker tools", () => {
  const setup = (charts: unknown[] = []) =>
    toolHarness({
      "GET /v0/projects/p1/event-marker-collections": () => COLLECTIONS,
      "POST /v0/projects/p1/event-marker-collections": (b) => ({ id: "mc2", ...(b as object) }),
      "POST /v0/projects/p1/event-marker-collections/mc1/events": (b) => marker(b as Record<string, unknown>),
      "POST /v0/projects/p1/event-marker-collections/mc1/events/bulk": (b) => (b as { events: Record<string, unknown>[] }).events.map(marker),
      "POST /v0/projects/p1/event-marker-collections/mc2/events/bulk": (b) => (b as { events: Record<string, unknown>[] }).events.map(marker),
      "PATCH /v0/projects/p1/event-marker-collections/mc1/events/ev1": (b) => marker({ title: "x", timestamp: "t", ...(b as Record<string, unknown>) }, 1),
      "DELETE /v0/projects/p1/event-marker-collections/mc1/events/ev1": () => undefined,
      "PATCH /v0/projects/p1/event-marker-collections/mc1": (b) => ({ ...COLLECTIONS[0], ...(b as object) }),
      "DELETE /v0/projects/p1/event-marker-collections/mc1": () => undefined,
      "GET /v0/projects/p1/charts": () => charts,
    });

  it("bulk creates into a collection found by name, passing externalId through", async () => {
    const { call, writes } = setup();
    const events = [{ timestamp: "2026-01-01T00:00:00Z", title: "1.0", externalId: "1.0" }, { timestamp: 1767225600, title: "1.1", externalId: "1.1" }];
    const r = await call("bulk_create_event_markers", { collectionName: "releases", events });
    expect(r.data).toMatchObject({ collectionId: "mc1", count: 2 });
    expect(writes()).toMatchObject([{ path: "/v0/projects/p1/event-marker-collections/mc1/events/bulk", body: { events } }]);
  });

  it("creates a missing collection for bulk create", async () => {
    const { call, writes } = setup();
    await call("bulk_create_event_markers", { collectionName: "Hotfixes", events: [{ timestamp: "t", title: "a" }] });
    expect(writes().map((w) => w.path)).toEqual([
      "/v0/projects/p1/event-marker-collections",
      "/v0/projects/p1/event-marker-collections/mc2/events/bulk",
    ]);
  });

  it("does not create a collection when updating or deleting", async () => {
    const { call, writes } = setup();
    expect((await call("update_event_marker", { collectionName: "Hotfixes", eventId: "ev1", title: "y" })).isError).toBe(true);
    expect((await call("delete_marker_collection", { collectionName: "Hotfixes", confirm: true })).isError).toBe(true);
    expect(writes()).toHaveLength(0);
  });

  it("updates a marker with only the given fields", async () => {
    const { call, writes } = setup();
    await call("update_event_marker", { collectionId: "mc1", eventId: "ev1", emoji: "🚀" });
    expect(writes()).toMatchObject([{ method: "PATCH", body: { emoji: "🚀" } }]);
  });

  it("deletes a marker", async () => {
    const { call, writes } = setup();
    expect((await call("delete_event_marker", { collectionId: "mc1", eventId: "ev1", confirm: true })).data).toEqual({ deleted: "ev1", collectionId: "mc1" });
    expect(writes()).toMatchObject([{ method: "DELETE", path: "/v0/projects/p1/event-marker-collections/mc1/events/ev1" }]);
  });

  it("updates a collection", async () => {
    const { call, writes } = setup();
    const r = await call("update_marker_collection", { collectionName: "Releases", name: "Versions", grouping: "day" });
    expect(r.data.updated).toMatchObject({ id: "mc1", name: "Versions", grouping: "day" });
    expect(writes()[0]!.body).toEqual({ name: "Versions", grouping: "day" });
  });

  it("deletes a collection and names the charts that overlaid it", async () => {
    const charts = [chart("c1", "d1", { markerCollections: [{ collectionId: "mc1" }] }), chart("c2", "d1", { markerCollections: [{ collectionId: "mc10" }] })];
    const r = await setup(charts).call("delete_marker_collection", { collectionId: "mc1", confirm: true });
    expect(r.data).toEqual({ deleted: "mc1", name: "Releases", chartsThatOverlaidIt: [{ id: "c1", name: "Chart c1" }] });
  });

  it("still supports single create with externalId", async () => {
    const { call, writes } = setup();
    await call("create_event_marker", { collectionId: "mc1", timestamp: "t", title: "2.0", externalId: "2.0" });
    expect(writes()[0]!.body).toEqual({ timestamp: "t", title: "2.0", externalId: "2.0" });
  });
});

describe("health tools", () => {
  const ANOMALIES = {
    grain: "hour", from: 1767225600, to: 1767312000000, baselineFrom: 1, seriesScanned: 3,
    health: [
      { metric: "servers", label: "Servers", unit: "count", current: 10, expected: 50, status: "anomalous", chart: { values: [1, 2, 3] } },
      { metric: "players", label: "Players", unit: "count", current: 5, expected: 5, status: "normal", chart: { values: [1] } },
    ],
    incidents: [{ id: "i1", kind: "gap", severity: "high", title: "Servers dropped", findings: [{ id: "f1", chart: { values: [1] }, observed: 10 }], causes: [] }],
  };
  const setup = (hasData = true) =>
    toolHarness({
      "GET /v0/projects/p1/check-data": () => hasData,
      "GET /v0/projects/p1/anomalies": () => ANOMALIES,
    });

  it("reports whether data arrives, with a hint when it does not", async () => {
    expect((await setup(true).call("check_project_data", {})).data).toMatchObject({ project: "p1", hasData: true });
    expect((await setup(false).call("check_project_data", {})).data.hint).toMatch(/token/);
  });

  it("strips chart series, hides normal metrics by default and converts times", async () => {
    const { call, calls } = setup();
    const r = await call("get_anomalies", { grain: "day" });
    expect(calls.at(-1)!.query).toEqual({ grain: "day" });
    expect(JSON.stringify(r.data)).not.toContain('"chart"');
    expect(r.data.health).toEqual([{ metric: "servers", label: "Servers", unit: "count", current: 10, expected: 50, status: "anomalous" }]);
    expect(r.data.normalMetrics).toBe(1);
    expect(r.data.incidents[0].findings[0]).toEqual({ id: "f1", observed: 10 });
    expect(r.data.from).toBe("2026-01-01T00:00:00.000Z");
    expect(r.data.to).toBe("2026-01-02T00:00:00.000Z");
    expect((await call("get_anomalies", { includeNormal: true })).data.health).toHaveLength(2);
  });
});

describe("download tools", () => {
  const LINKED = [{ id: "dp1", projectId: "p1", provider: "modrinth", externalId: "AbC", slug: "limited-lives", title: "Limited Lives", lastSyncedAt: null, createdAt: "x" }];
  const versions = Array.from({ length: 30 }, (_, i) => ({ provider: "modrinth", externalId: "AbC", versionId: `v${i}`, versionNumber: `1.${i}`, downloads: i, latestSnapshotAt: null, releaseDate: null }));
  const setup = (linked = LINKED) =>
    toolHarness({
      "GET /v0/projects/p1/downloads": () => ({
        overview: { totalDownloads: 435, providersTracked: 1, projectsTracked: 1, latestSnapshotAt: null },
        history: [{ bucket: "2026-01-01", downloads: 400, gained: 3 }],
        providerBreakdown: [],
        providerSummaries: [{ provider: "modrinth", downloads: 435, latestSnapshotAt: null }],
        versions,
      }),
      "GET /v0/projects/p1/download-providers": () => linked,
      "GET /v0/projects/p1/download-providers/search": (_b, q) => [{ provider: q.provider, externalId: "AbC", title: q.query }],
      "POST /v0/projects/p1/download-providers": (b) => ({ id: "dp2", projectId: "p1", title: "New", lastSyncedAt: null, createdAt: "x", ...(b as object) }),
      "DELETE /v0/projects/p1/download-providers/dp1": () => undefined,
    });

  it("returns top versions, linked listings, and history only on request", async () => {
    const { call, calls } = setup();
    const r = await call("get_download_analytics", { provider: "modrinth", dateFrom: "2026-01-01" });
    expect(calls.find((c) => c.path.endsWith("/downloads"))!.query).toEqual({ provider: "modrinth", dateFrom: "2026-01-01" });
    expect(r.data.versions).toHaveLength(25);
    expect(r.data.versions[0].versionNumber).toBe("1.29");
    expect(r.data.moreVersions).toBe(5);
    expect(r.data.history).toBeUndefined();
    expect(r.data.linked).toEqual([{ id: "dp1", provider: "modrinth", externalId: "AbC", slug: "limited-lives", title: "Limited Lives", url: null, lastSyncedAt: null }]);
    expect((await call("get_download_analytics", { includeHistory: true, versionLimit: 100 })).data).toMatchObject({ history: [{ downloads: 400 }] });
  });

  it("hints at linking when nothing is linked", async () => {
    expect((await setup([]).call("get_download_analytics", {})).data.hint).toMatch(/link_download_provider/);
  });

  it("searches a provider", async () => {
    const r = await setup().call("search_download_providers", { provider: "hangar", query: "Limited Lives" });
    expect(r.data).toEqual([{ provider: "hangar", externalId: "AbC", title: "Limited Lives" }]);
  });

  it("links once and reports an existing link instead of duplicating", async () => {
    const { call, writes } = setup();
    expect((await call("link_download_provider", { provider: "modrinth", externalId: "AbC" })).data.alreadyLinked.id).toBe("dp1");
    expect(writes()).toHaveLength(0);
    expect((await call("link_download_provider", { provider: "spigot", externalId: "123" })).data.linked.id).toBe("dp2");
    expect(writes()[0]!.body).toEqual({ provider: "spigot", externalId: "123" });
  });

  it("unlinks by slug and rejects unknown listings", async () => {
    const { call, writes } = setup();
    expect((await call("unlink_download_provider", { providerId: "nope", confirm: true })).isError).toBe(true);
    expect((await call("unlink_download_provider", { providerId: "limited-lives", confirm: true })).data).toEqual({ unlinked: "dp1", provider: "modrinth", title: "Limited Lives" });
    expect(writes()).toMatchObject([{ method: "DELETE", path: "/v0/projects/p1/download-providers/dp1" }]);
  });
});
