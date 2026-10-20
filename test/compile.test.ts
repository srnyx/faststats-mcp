import { describe, expect, it } from "vitest";
import { compile } from "../src/flow/compile";
import { ChartSpec, Step } from "../src/flow/spec";
import { FieldCatalog } from "../src/flow/fields";
import { limitedLivesCatalog } from "./helpers";

const spec = (s: unknown) => ChartSpec.parse(s);

describe("spec parsing", () => {
  it("disambiguates steps that share keys", () => {
    expect(Step.parse({ timeGroup: "hour", gapFill: "none" })).toEqual({ timeGroup: "hour", gapFill: "none" });
    expect(Step.parse({ gapFill: "zero" })).toEqual({ gapFill: "zero" });
    expect(Step.parse({ datasource: "x", dedupe: false })).toEqual({ datasource: "x", dedupe: false });
    expect(Step.parse({ dedupe: "server_id" })).toEqual({ dedupe: "server_id" });
  });

  it("rejects unknown keys", () => {
    expect(() => Step.parse({ aggregate: "count", extra: 1 })).toThrow();
    expect(() => Step.parse({ aggregate: "mean" })).toThrow();
  });
});

describe("compile", () => {
  const catalog = limitedLivesCatalog();

  it("compiles a custom array metric breakdown", () => {
    const out = compile(
      spec({
        name: "Death causes",
        chartType: "pie",
        outputs: [{ name: "Servers", steps: [{ datasource: "config_death_causes" }, { groupBy: "config_death_causes" }, { aggregate: "count" }, { limit: 8, groupOthers: true }] }],
        visual: { pie: { style: "donut" } },
      }),
      catalog,
    );
    expect(out.errors).toEqual([]);
    expect(out.flow.nodes.map((n) => [n.id, n.data])).toEqual([
      ["datasource-0-0", { datasource: "config_death_causes", dedupe: true }],
      ["groupBy-0-1", { field: "config_death_causes" }],
      ["aggregate-0-2", { function: "count" }],
      ["limit-0-3", { limit: 8, groupOthers: true }],
      ["result-0-4", { outputName: "Servers" }],
    ]);
    expect(out.queryConfig).toEqual({ visualOptions: { pie: { style: "donut" } } });
  });

  it("wires formula inputs in A, B order", () => {
    const out = compile(
      spec({
        name: "Players per server",
        chartType: "widget",
        outputs: [
          {
            name: "Players / server",
            formula: "A / B",
            precision: 2,
            inputs: [
              { steps: [{ datasource: "internal:player_count" }, { maxAge: "30m" }, { aggregate: "sum" }] },
              { steps: [{ datasource: "internal:server_count" }, { maxAge: "30m" }, { aggregate: "count" }] },
            ],
          },
        ],
      }),
      catalog,
    );
    expect(out.errors).toEqual([]);
    const into = out.flow.edges.filter((e) => e.target === "formula-0").map((e) => e.source);
    expect(into).toEqual(["aggregate-0-0-2", "aggregate-0-1-2"]);
    expect(out.flow.nodes.find((n) => n.id === "maxAge-0-0-1")!.data).toEqual({ value: 30, unit: "m" });
    expect(out.flow.nodes.find((n) => n.id === "formula-0")!.data).toEqual({ formula: "A / B", outputName: "Players / server", precision: 2 });
  });

  it("rejects formula variables that have no input", () => {
    const out = compile(
      spec({ name: "x", chartType: "widget", outputs: [{ name: "x", formula: "A / C", inputs: [{ steps: [{ datasource: "internal:player_count" }, { aggregate: "sum" }] }, { steps: [{ datasource: "internal:server_count" }, { aggregate: "count" }] }] }] }),
      catalog,
    );
    expect(out.errors.join()).toMatch(/"C"/);
  });

  it("suggests close field names", () => {
    const out = compile(spec({ name: "x", chartType: "list", outputs: [{ name: "x", steps: [{ datasource: "internal:server_count" }, { groupBy: "config_death_cause" }, { aggregate: "count" }] }] }), catalog);
    expect(out.errors[0]).toMatch(/Did you mean "config_death_causes"/);
  });

  it("requires a datasource first", () => {
    const out = compile(spec({ name: "x", chartType: "widget", outputs: [{ name: "x", steps: [{ aggregate: "count" }] }] }), catalog);
    expect(out.errors[0]).toMatch(/first step must be/);
  });

  it("warns about common mistakes", () => {
    const out = compile(
      spec({ name: "x", chartType: "line", outputs: [{ name: "x", steps: [{ datasource: "config" }, { filter: { field: "config", op: "equals", value: "x" } }, { aggregate: "count" }] }] }),
      catalog,
    );
    expect(out.errors).toEqual([]);
    expect(out.warnings.join("\n")).toMatch(/map metric/);
    expect(out.warnings.join("\n")).toMatch(/timeGroup/);
  });

  it("types filter values", () => {
    const out = compile(
      spec({ name: "x", chartType: "widget", outputs: [{ name: "x", steps: [{ datasource: "internal:server_count" }, { filter: { field: "internal:online_mode", op: "equals", value: true } }, { aggregate: "count" }] }] }),
      catalog,
    );
    expect(out.flow.nodes[1]!.data).toEqual({ field: "internal:online_mode", operator: "equals", value: "true", dataType: "boolean" });
  });
});

describe("dot paths into JSON metrics", () => {
  const json = (referenceId: string) => ({ id: referenceId, name: referenceId, referenceId, dataType: "json", metricShape: "scalar", isArray: false });
  const catalog = new FieldCatalog("minecraft-plugin", [json("storage"), json("config")]);
  const breakdown = (field: string) =>
    spec({ name: "x", chartType: "pie", outputs: [{ name: "Servers", steps: [{ datasource: "internal:server_count" }, { groupBy: field }, { aggregate: "count" }] }] });

  it("accepts nested keys on a JSON metric", () => {
    const out = compile(breakdown("storage.cache.enabled"), catalog);
    expect(out.errors).toEqual([]);
    expect(out.flow.nodes.find((n) => n.type === "groupBy")?.data).toEqual({ field: "storage.cache.enabled" });
  });

  it("accepts dot paths in filters", () => {
    const out = compile(
      spec({
        name: "x",
        chartType: "widget",
        outputs: [{ name: "H2", steps: [{ datasource: "internal:server_count" }, { filter: { field: "storage.method", op: "equals", value: "H2" } }, { aggregate: "count" }] }],
      }),
      catalog,
    );
    expect(out.errors).toEqual([]);
  });

  it("still rejects unknown roots and malformed paths", () => {
    expect(compile(breakdown("nope.method"), catalog).errors[0]).toMatch(/unknown field "nope.method"/);
    expect(compile(breakdown("storage..method"), catalog).errors[0]).toMatch(/unknown field/);
    expect(compile(breakdown("storage."), catalog).errors[0]).toMatch(/unknown field/);
  });

  it("explains the map-metric alternative instead of accepting a dot path", () => {
    const err = compile(breakdown("config.lives.default"), limitedLivesCatalog()).errors[0];
    expect(err).toMatch(/"config" is a map metric/);
    expect(err).toMatch(/"mapTarget": "key"/);
  });
});
