import { z } from "zod";
import { ChartType, MarkerCollectionRef, VisualOptions } from "../api/types";

// The "series spec" is the input format Claude writes. It is compiled into a
// FastStats flow graph by compile.ts and decompiled back by decompile.ts.

export const FIELD_TYPES = ["string", "number", "boolean", "datetime"] as const;
export const DEDUPE_IDENTITIES = ["user_id", "server_id", "version_id", "project"] as const;
export const AGGREGATES = ["count", "sum", "avg", "median", "min", "max", "distinct"] as const;
export const INTERVALS = ["auto", "minute", "hour", "day", "week", "month"] as const;
export const GAP_FILL = ["zero", "none"] as const;
export const DURATION_UNITS = ["ms", "s", "m", "h", "d"] as const;
export const SORT_BY = ["value", "dimension", "time"] as const;
export const SORT_DIR = ["asc", "desc"] as const;
export const GROUP_MODES = ["combined", "flat"] as const;
export const TRANSFORMS = [
  "toLowerCase", "toUpperCase", "toTitleCase", "trim", "append", "replace", "replaceRegex", "length",
] as const;
export const FILTER_OPS = [
  "equals", "not_equals", "contains", "regex", "regex_not", "greater_than", "less_than", "greater_equal", "less_equal",
] as const;

export const Duration = z.union([
  z.string().regex(/^\d+(\.\d+)?\s*(ms|s|m|h|d)$/, "Use a duration like \"30m\", \"6h\", \"7d\""),
  z.strictObject({ value: z.number().positive(), unit: z.enum(DURATION_UNITS) }),
]);
export type Duration = z.infer<typeof Duration>;

export const Step = z.union([
  z.strictObject({
    datasource: z.string().describe("internal:* field or a custom metric referenceId"),
    dedupe: z.boolean().optional().describe("Default true (one row per server). Matches every built-in chart."),
    dedupeIdentity: z.enum(DEDUPE_IDENTITIES).optional(),
    dataType: z.enum(FIELD_TYPES).optional().describe("Override the inferred data type"),
  }),
  z.strictObject({
    filter: z.strictObject({
      field: z.string(),
      op: z.enum(FILTER_OPS),
      value: z.union([z.string(), z.number(), z.boolean()]),
      dataType: z.enum(FIELD_TYPES).optional(),
      mapTarget: z.enum(["key", "value"]).optional().describe("For map metrics: match on the entry key or value"),
    }),
  }),
  z.strictObject({ aggregate: z.enum(AGGREGATES) }),
  z.strictObject({
    groupBy: z.union([z.string(), z.array(z.string()).min(1)]),
    mode: z.enum(GROUP_MODES).optional().describe("Only for multiple fields"),
  }),
  z.strictObject({
    timeGroup: z.enum(INTERVALS),
    gapFill: z.enum(GAP_FILL).optional(),
    cumulative: z.boolean().optional(),
  }),
  z.strictObject({ maxAge: Duration.describe("Keep only data newer than this, e.g. \"30m\" = currently online") }),
  z.strictObject({ minAge: Duration.describe("Keep only data older than this") }),
  z.strictObject({ limit: z.number().int().positive(), groupOthers: z.boolean().optional() }),
  z.strictObject({ sort: z.enum(SORT_BY), direction: z.enum(SORT_DIR).optional() }),
  z.strictObject({ gapFill: z.enum(GAP_FILL) }),
  z.strictObject({ dedupe: z.enum(DEDUPE_IDENTITIES) }),
  z.strictObject({
    transform: z.enum(TRANSFORMS),
    pattern: z.string().optional(),
    replacement: z.string().optional(),
  }),
  z.strictObject({
    node: z.string().describe("Escape hatch: raw flow node type"),
    data: z.record(z.string(), z.unknown()),
  }),
]);
export type Step = z.infer<typeof Step>;

export const Display = z.strictObject({
  iconSetId: z.string().optional().describe("e.g. builtin:os"),
  color: z.string().optional(),
  colors: z.array(z.string()).optional(),
  splitPattern: z.string().optional().describe("Label pattern, e.g. \"{key}: {value}\" for map metrics"),
  splitDataSource: z.string().optional().describe("Secondary field to drill into, e.g. internal:os_version"),
  splitByCustomPattern: z.boolean().optional(),
});
export type Display = z.infer<typeof Display>;

const Steps = z.array(Step).min(1).describe("Linear pipeline; the first step must be a datasource");

export const SeriesOutput = z.strictObject({
  name: z.string().min(1).describe("Series / tab label"),
  steps: Steps,
  display: Display.optional(),
});

export const FormulaOutput = z.strictObject({
  name: z.string().min(1),
  formula: z.string().min(1).describe("Arithmetic over inputs named A, B, C… in order, e.g. \"A / B * 100\""),
  precision: z.number().int().min(0).max(10).optional(),
  inputs: z.array(z.strictObject({ steps: Steps })).min(1).max(26),
  display: Display.optional(),
});

export const Output = z.union([FormulaOutput, SeriesOutput]);
export type Output = z.infer<typeof Output>;
export type SeriesOutput = z.infer<typeof SeriesOutput>;
export type FormulaOutput = z.infer<typeof FormulaOutput>;

export const Size = z.strictObject({ w: z.number().int().min(1).max(12), h: z.number().int().min(1).max(12) });

export const ChartSpec = z.strictObject({
  name: z.string().min(1),
  chartType: ChartType,
  description: z.string().optional(),
  outputs: z
    .array(Output)
    .min(1)
    .describe("One entry per series (line/area/bar), tab (list) or value. Each ends in its own result node."),
  visual: VisualOptions.optional(),
  groupLimit: z.number().int().positive().optional(),
  markerCollections: z.array(MarkerCollectionRef).optional(),
  size: Size.optional().describe("Grid size; omitted = default for the chart type"),
});
export type ChartSpec = z.infer<typeof ChartSpec>;

export const isFormula = (o: Output): o is FormulaOutput => "formula" in o;

export function parseDuration(d: Duration): { value: number; unit: (typeof DURATION_UNITS)[number] } {
  if (typeof d !== "string") return d;
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/.exec(d.trim());
  if (!m) throw new Error(`Invalid duration "${d}"`);
  return { value: Number(m[1]), unit: m[2] as (typeof DURATION_UNITS)[number] };
}

export function formatDuration(value: unknown, unit: unknown): Duration {
  if (typeof value === "number" && typeof unit === "string" && (DURATION_UNITS as readonly string[]).includes(unit)) {
    return `${value}${unit}`;
  }
  return { value: Number(value), unit: (unit as (typeof DURATION_UNITS)[number]) ?? "h" };
}
