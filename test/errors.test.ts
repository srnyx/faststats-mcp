import { describe, expect, it, vi } from "vitest";
import { parseTime } from "../src/tools/errors";
import { toolHarness } from "./helpers";

const NOW = Date.parse("2026-10-20T08:00:00.000Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

const issue = (errorId: string, o: Record<string, unknown> = {}) => ({
  id: `row-${errorId}`,
  projectId: "p1",
  hash: "h",
  errorId,
  errorName: "NullPointerException",
  errorMessage: `boom ${errorId}`,
  latestStack: ["at a.B(B.java:1)", "at c.D(D.java:2)"],
  mappedLatestStack: [],
  occurrenceCount: 10,
  affectedSessionCount: 3,
  firstOccurred: hoursAgo(100),
  lastOccurred: hoursAgo(1),
  pluginVersion: "1.4.0",
  firstPluginVersion: "1.3.0",
  viewed: false,
  status: "active",
  regressed: false,
  labels: [{ id: "l1", name: "bug", color: "#f00" }],
  eventTrend: [1, 2, 3],
  ...o,
});

const ISSUES = [
  issue("old"), // seen before the window and not regressed: not "new"
  issue("fresh", { firstOccurred: hoursAgo(2), occurrenceCount: 5 }),
  issue("fresh-big", { firstOccurred: hoursAgo(3), occurrenceCount: 50, projectId: "p2" }),
  issue("back", { regressed: true, lastOccurred: hoursAgo(5) }),
  issue("back-stale", { regressed: true, lastOccurred: hoursAgo(48) }), // regressed, but not within the window
  issue("seen", { firstOccurred: hoursAgo(1), viewed: true }),
];

function setup() {
  return toolHarness({
    "GET /v0/projects": () => ({ items: [{ id: "p1", name: "LL", slug: "p1" }, { id: "p2", name: "Other", slug: "p2" }], hasMore: false }),
    "POST /v0/projects/p1/errors/issues/query": () => ISSUES.filter((i) => i.projectId === "p1"),
    "POST /v0/errors/issues/query": () => ISSUES,
    "POST /v0/errors/timeseries/query": () => [{ date: "2026-10-19", errors: 7, uniqueErrors: 2, bucketStart: "x" }],
    "GET /v0/projects/p1/errors/issues/e1": () => ({
      issue: issue("e1", { latestStack: Array.from({ length: 80 }, (_, i) => `frame ${i}`), resolution: null, commentCount: 2 }),
      timeline: Array.from({ length: 40 }, (_, i) => ({ date: `d${i}`, errors: i, uniqueErrors: 1, bucketStart: "x" })),
      memberGroupHashes: [],
    }),
    "GET /v0/projects/p1/errors/issues/e1/occurrences": (_b, q) =>
      Array.from({ length: Number(q.limit) }, (_, i) => ({
        id: `o${i}`, projectId: "p1", hash: "h", errorId: "e1", count: 1, createdAt: hoursAgo(i),
        latestStack: ["raw"], mappedStack: ["mapped 1", "mapped 2"], context: { world: "nether" },
        minecraftVersion: "1.21.4", javaVersion: "21", serverType: "Paper",
      })),
    "GET /v0/projects/p1/errors/issues/e1/stacktrace-variants": () => [{ id: "v1", latestOccurrenceId: "o1", stack: ["x"], language: "java", errorName: "E", errorMessage: "m", occurrenceCount: 4, firstOccurred: 1, lastOccurred: 2 }],
    "GET /v0/projects/p1/errors/filters": () => ({ country_values: ["DE"], plugin_version_values: ["1.3.0", "1.4.0"], browser_values: [], os_values: null }),
    "GET /v0/projects/p1/errors/labels": () => [{ id: "l1", name: "bug", color: "#f00", issueCount: 4 }, { id: "l2", name: "Needs Info", color: "#0f0" }],
    "PATCH /v0/projects/p1/errors/issues/e1": () => undefined,
    "PUT /v0/projects/p1/errors/issues/e1/labels": () => undefined,
    "POST /v0/errors/resolve": () => undefined,
    "POST /v0/projects/p1/errors/resolutions/clear": () => undefined,
    "POST /v0/projects/p1/errors/issues/viewed": () => undefined,
    "POST /v0/projects/p1/errors/issues/merge": (b) => ({ primaryErrorId: (b as { primaryErrorId: string }).primaryErrorId }),
    "POST /v0/projects/p1/errors/issues/delete": (b) => ({ ids: (b as { ids: string[] }).ids, pending: true }),
  });
}

describe("parseTime", () => {
  it("reads durations relative to now and ISO timestamps", () => {
    expect(parseTime("24h", NOW).toISOString()).toBe(hoursAgo(24));
    expect(parseTime("7d", NOW).getTime()).toBe(NOW - 7 * 86_400_000);
    expect(parseTime("30m", NOW).getTime()).toBe(NOW - 1_800_000);
    expect(parseTime("2w", NOW).getTime()).toBe(NOW - 14 * 86_400_000);
    expect(parseTime("2026-10-01T00:00:00Z").toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(() => parseTime("yesterday")).toThrow(/duration/);
  });
});

describe("list_errors", () => {
  it("returns only new and regressed issues across all projects for a digest", async () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    try {
      const { call, calls } = setup();
      const r = await call("list_errors", { projects: "all", newSince: "24h" });
      const q = calls.find((c) => c.path === "/v0/errors/issues/query")!;
      expect(q.body).toEqual({ projectIds: ["p1", "p2"], from: NOW - 86_400_000, status: "active", limit: 500 });
      expect(r.data.issues.map((i: { errorId: string; reason: string }) => [i.errorId, i.reason])).toEqual([
        ["fresh-big", "new"], // new first, most occurrences first (50, 10, 5)
        ["seen", "new"],
        ["fresh", "new"],
        ["back", "regressed"],
      ]);
      expect(r.data.issues[0].project).toBe("p2");
      expect(r.data.window.from).toBe(hoursAgo(24));
    } finally {
      vi.useRealTimers();
    }
  });

  it("can skip issues somebody already viewed", async () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    try {
      const r = await setup().call("list_errors", { projects: "all", newSince: "24h", unviewedOnly: true });
      expect(r.data.issues.map((i: { errorId: string }) => i.errorId)).not.toContain("seen");
    } finally {
      vi.useRealTimers();
    }
  });

  it("queries one project with filters and returns a compact summary", async () => {
    const { call, calls } = setup();
    const filters = [{ field: "plugin_version", operator: "equals", value: "1.4.0" }];
    const r = await call("list_errors", { status: "all", search: "NPE", filters, limit: 2, stackFrames: 1 });
    expect(calls.find((c) => c.method === "POST")).toMatchObject({ path: "/v0/projects/p1/errors/issues/query", body: { status: "all", searchQuery: "NPE", filters, limit: 2 } });
    expect(r.data.total).toBe(5);
    expect(r.data.issues).toHaveLength(2);
    expect(r.data.more).toBe(3);
    expect(r.data.issues[0]).toEqual({
      errorId: "old", id: "row-old", name: "NullPointerException", message: "boom old", status: "active", regressed: false, viewed: false,
      priority: null, assignee: null, labels: ["bug"], occurrences: 10, sessions: 3, firstSeen: hoursAgo(100), lastSeen: hoursAgo(1),
      firstVersion: "1.3.0", latestVersion: "1.4.0", stack: ["at a.B(B.java:1)"],
    });
    expect(r.data.issues[0]).not.toHaveProperty("project");
  });

  it("adds the error trend on request", async () => {
    const r = await setup().call("list_errors", { projects: ["p1", "p2"], includeTrend: true });
    expect(r.data.trend).toEqual([{ date: "2026-10-19", errors: 7, uniqueErrors: 2 }]);
  });

  it("rejects unreadable times", async () => {
    const r = await setup().call("list_errors", { newSince: "last week" });
    expect(r.isError).toBe(true);
  });
});

describe("get_error and filter options", () => {
  it("returns the full issue with capped stack, timeline and occurrences", async () => {
    const { call, calls } = setup();
    const r = await call("get_error", { errorId: "e1", occurrences: 2, variants: 3 });
    expect(r.data.stack).toHaveLength(60);
    expect(r.data.timeline).toHaveLength(30);
    expect(r.data.comments).toBe(2);
    expect(r.data.occurrences).toHaveLength(2);
    expect(r.data.occurrences[0]).toMatchObject({ id: "o0", minecraftVersion: "1.21.4", serverType: "Paper", stack: ["mapped 1", "mapped 2"], context: { world: "nether" } });
    expect(r.data.occurrences[0]).not.toHaveProperty("latestStack");
    expect(r.data.variants).toEqual([{ id: "v1", occurrences: 4, stack: ["x"] }]);
    expect(calls.find((c) => c.path.endsWith("/stacktrace-variants"))!.query).toEqual({ limit: "3" });
  });

  it("skips occurrence and variant calls when not wanted", async () => {
    const { call, calls } = setup();
    await call("get_error", { errorId: "e1", occurrences: 0 });
    expect(calls.map((c) => c.path)).toEqual(["/v0/projects/p1", "/v0/projects/p1/errors/issues/e1"]);
  });

  it("lists non-empty filter fields and labels", async () => {
    const r = await setup().call("get_error_filter_options", {});
    expect(r.data.filters).toEqual({ country: ["DE"], plugin_version: ["1.3.0", "1.4.0"] });
    expect(r.data.labels).toEqual([{ id: "l1", name: "bug", color: "#f00", issues: 4 }, { id: "l2", name: "Needs Info", color: "#0f0" }]);
  });
});

describe("error write tools", () => {
  it("updates priority and resolves label names to ids", async () => {
    const { call, writes } = setup();
    const r = await call("update_error", { errorId: "e1", priority: "high", labels: ["needs info", "l1"] });
    expect(r.isError).toBe(false);
    expect(writes()).toMatchObject([
      { method: "PATCH", path: "/v0/projects/p1/errors/issues/e1", body: { priority: "high" } },
      { method: "PUT", path: "/v0/projects/p1/errors/issues/e1/labels", body: { labelIds: ["l2", "l1"] } },
    ]);
  });

  it("rejects unknown labels and empty updates without writing", async () => {
    const { call, writes } = setup();
    expect((await call("update_error", { errorId: "e1", labels: ["nope"] })).data.error).toMatch(/Unknown labels: nope/);
    expect((await call("update_error", { errorId: "e1" })).isError).toBe(true);
    expect(writes()).toHaveLength(0);
  });

  it("clears labels with an empty list", async () => {
    const { call, writes } = setup();
    await call("update_error", { errorId: "e1", labels: [] });
    expect(writes()).toMatchObject([{ method: "PUT", body: { labelIds: [] } }]);
  });

  it("resolves with the project id and mode, and reopens", async () => {
    const { call, writes } = setup();
    await call("resolve_errors", { errorIds: ["e1", "e2"], mode: "version", note: "fixed in 1.4.1" });
    await call("reopen_errors", { errorIds: ["e1"] });
    expect(writes()).toMatchObject([
      { path: "/v0/errors/resolve", body: { projects: [{ projectId: "p1", errorIds: ["e1", "e2"] }], mode: "version", note: "fixed in 1.4.1" } },
      { path: "/v0/projects/p1/errors/resolutions/clear", body: { errorIds: ["e1"] } },
    ]);
  });

  it("marks viewed, merges and deletes", async () => {
    const { call, writes } = setup();
    await call("mark_errors_viewed", { errorIds: ["e1"] });
    expect((await call("merge_errors", { primaryErrorId: "e1", mergedErrorIds: ["e1"], confirm: true })).isError).toBe(true);
    expect((await call("merge_errors", { primaryErrorId: "e1", mergedErrorIds: ["e2", "e3"], confirm: true })).data).toEqual({ primaryErrorId: "e1", merged: ["e2", "e3"] });
    expect((await call("delete_errors", { errorIds: ["e9"], confirm: true })).data).toEqual({ deleted: ["e9"], note: "Deletion is processing in the background." });
    expect(writes().map((w) => [w.path, w.body])).toEqual([
      ["/v0/projects/p1/errors/issues/viewed", { ids: ["e1"] }],
      ["/v0/projects/p1/errors/issues/merge", { primaryErrorId: "e1", mergedErrorIds: ["e2", "e3"] }],
      ["/v0/projects/p1/errors/issues/delete", { ids: ["e9"] }],
    ]);
  });
});
