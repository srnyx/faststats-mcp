import { describe, expect, it } from "vitest";
import { compile } from "../src/flow/compile";
import { decompileChart } from "../src/flow/decompile";
import { ChartSpec } from "../src/flow/spec";
import { limitedLivesCatalog, loadDefaultCharts } from "./helpers";

const strip = (flow: { nodes: { id: string; type?: string; data?: unknown }[]; edges: unknown[] }) => ({
  nodes: flow.nodes.map(({ id, type, data }) => ({ id, type, data })),
  edges: flow.edges,
});

describe("decompile → compile round-trip on the 12 default Minecraft charts", () => {
  for (const chart of loadDefaultCharts()) {
    it(chart.name, () => {
      const { spec, warnings } = decompileChart(chart);
      expect(warnings).toEqual([]);
      // Clean specs only: no raw escape-hatch steps.
      expect(JSON.stringify(spec)).not.toContain('"node"');
      // The decompiled spec must itself be valid tool input.
      const parsed = ChartSpec.parse(spec);
      const out = compile(parsed, limitedLivesCatalog());
      expect(out.errors).toEqual([]);
      expect(strip(out.flow)).toEqual(strip(chart.query));
      expect(out.queryConfig.visualOptions ?? null).toEqual((chart.queryConfig as { visualOptions: unknown }).visualOptions);
    });
  }

  it("decompiles the Java Versions chart into readable steps", () => {
    const java = loadDefaultCharts().find((c) => c.name === "Java Versions")!;
    expect(decompileChart(java).spec.outputs).toEqual([
      {
        name: "Java Versions",
        steps: [
          { datasource: "internal:server_count" },
          { groupBy: "internal:java_version" },
          { aggregate: "count" },
          { transform: "replaceRegex", pattern: "^(?:1\\.)?(\\d+).*$", replacement: "\\1" },
        ],
      },
    ]);
  });

  it("keeps unknown node data as raw steps instead of dropping it", () => {
    const chart = loadDefaultCharts()[0]!;
    const node = chart.query.nodes[1]!;
    node.data = { ...node.data, futureOption: 42 };
    const { spec } = decompileChart(chart);
    const steps = (spec.outputs[0] as { steps: unknown[] }).steps;
    expect(steps[1]).toEqual({ node: "aggregate", data: { function: "count", futureOption: 42 } });
    expect(strip(compile(ChartSpec.parse(spec)).flow)).toEqual(strip(chart.query));
  });
});
