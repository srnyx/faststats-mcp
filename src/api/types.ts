import { z } from "zod";

// Hand-written models for the endpoints this server uses, taken from
// https://api.faststats.dev/openapi.json (v0.0.1). Responses are parsed with
// looseObject so new fields from FastStats never break the server;
// test/contract.test.ts checks the enums against the live spec.

export const CHART_TYPES = [
  "widget", "line", "area", "bar", "pie", "map", "list", "heatmap", "radar", "scatter", "treemap", "table",
] as const;
export const ChartType = z.enum(CHART_TYPES);
export type ChartType = z.infer<typeof ChartType>;

const nullish = <T extends z.ZodType>(t: T) => t.nullish();

export const Position = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
});
export type Position = z.infer<typeof Position>;

export const MarkerDisplay = z.object({
  icon: nullish(z.string()),
  emoji: nullish(z.string()),
  color: nullish(z.string()),
});

export const MarkerCollectionRef = z.object({
  collectionId: z.string(),
  enabled: nullish(z.boolean()),
  display: nullish(MarkerDisplay),
});

export const VisualOptions = z.object({
  colors: nullish(z.array(z.string())).describe("Series/slice colors as hex strings, in output order"),
  thresholds: nullish(z.array(z.object({ value: z.number(), label: nullish(z.string()), color: nullish(z.string()) }))),
  valueFormat: nullish(z.object({
    unit: nullish(z.enum(["number", "percent", "percent_ratio", "duration_ms", "duration_s", "bytes", "custom"])),
    customUnit: nullish(z.string()),
    decimals: nullish(z.number()),
  })),
  valueAxis: nullish(z.object({ min: nullish(z.number()), max: nullish(z.number()) })),
  pie: nullish(z.object({
    style: nullish(z.enum(["pie", "donut"])),
    showLegend: nullish(z.boolean()),
    showTotal: nullish(z.boolean()),
    showLabels: nullish(z.boolean()),
    totalDisplayMode: nullish(z.enum(["sum", "count"])),
    drilldown: nullish(z.object({ enabled: nullish(z.boolean()), splitPattern: nullish(z.string()) })),
  })),
  bar: nullish(z.object({
    logarithmic: nullish(z.boolean()),
    stacked: nullish(z.boolean()),
    orientation: nullish(z.enum(["vertical", "horizontal"])),
  })),
  line: nullish(z.object({
    logarithmic: nullish(z.boolean()),
    lineType: nullish(z.enum(["monotone", "linear", "step"])),
    showDots: nullish(z.boolean()),
  })),
  widget: nullish(z.object({
    showTrend: nullish(z.boolean()),
    displayMode: nullish(z.enum(["default", "compact"])),
    valueFormat: nullish(z.enum(["number", "percent", "duration_ms"])),
  })),
  list: nullish(z.object({
    selectedTabIndex: nullish(z.number()),
    splitPattern: nullish(z.string()),
    multiMetric: nullish(z.boolean()),
  })),
  heatmap: nullish(z.object({ showLegend: nullish(z.boolean()) })),
  radar: nullish(z.object({
    logarithmic: nullish(z.boolean()),
    showDots: nullish(z.boolean()),
    fillOpacity: nullish(z.number()),
    showLegend: nullish(z.boolean()),
    gridType: nullish(z.enum(["polygon", "circle"])),
  })),
  scatter: nullish(z.object({
    logarithmic: nullish(z.boolean()),
    pointSize: nullish(z.enum(["small", "medium", "large"])),
    showLegend: nullish(z.boolean()),
  })),
  table: nullish(z.object({ showBars: nullish(z.boolean()), showTotals: nullish(z.boolean()) })),
});
export type VisualOptions = z.infer<typeof VisualOptions>;

export const QueryConfig = z.object({
  groupLimit: nullish(z.number()),
  visualOptions: nullish(VisualOptions),
  markerCollections: nullish(z.array(MarkerCollectionRef)),
});
export type QueryConfig = z.infer<typeof QueryConfig>;

export const FlowNode = z.object({
  id: z.string(),
  type: z.string().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
  position: z.object({ x: z.number().nullish(), y: z.number().nullish() }).optional(),
});
export type FlowNode = z.infer<typeof FlowNode>;

export const FlowEdge = z.object({ id: z.string(), source: z.string(), target: z.string() });
export type FlowEdge = z.infer<typeof FlowEdge>;

export const Flow = z.object({
  type: z.literal("flow"),
  nodes: z.array(FlowNode),
  edges: z.array(FlowEdge),
});
export type Flow = z.infer<typeof Flow>;

// ---- responses (loose) ----

export const ProjectSummary = z.looseObject({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  templateId: z.string().nullish(),
  private: z.boolean().optional(),
  createdAt: z.string().optional(),
  firstEventAt: z.string().nullish(),
});
export type ProjectSummary = z.infer<typeof ProjectSummary>;

export const ProjectPage = z.looseObject({
  items: z.array(ProjectSummary),
  total: z.number().nullish(),
  hasMore: z.boolean(),
});

export const DataSource = z.looseObject({
  id: z.string(),
  name: z.string(),
  description: z.string().nullish(),
  referenceId: z.string(),
  dataType: z.string(),
  metricShape: z.string().nullish(),
  isArray: z.boolean().nullish(),
});
export type DataSource = z.infer<typeof DataSource>;

export const Dashboard = z.looseObject({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  description: z.string().nullish(),
  isPublic: z.boolean().optional(),
  isDefault: z.boolean().optional(),
  position: z.number().nullish(),
});
export type Dashboard = z.infer<typeof Dashboard>;

export const Chart = z.looseObject({
  id: z.string(),
  projectId: z.string(),
  dashboardId: z.string(),
  name: z.string(),
  description: z.string().nullish(),
  chartType: z.string(),
  queryConfig: z.unknown().optional(),
  query: Flow,
  position: z.object({
    x: z.number().nullish(),
    y: z.number().nullish(),
    w: z.number().nullish(),
    h: z.number().nullish(),
  }).nullish(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});
export type Chart = z.infer<typeof Chart>;

export const PreviewOutput = z.looseObject({
  id: z.string(),
  index: z.number().nullish(),
  name: z.string(),
});

export const PreviewResponse = z.looseObject({
  data: z.unknown(),
  flowMeta: z.looseObject({
    outputs: z.array(PreviewOutput),
    hasTimeGroup: z.boolean().optional(),
    datasourceFields: z.array(z.string()).optional(),
  }),
});
export type PreviewResponse = z.infer<typeof PreviewResponse>;

export const MarkerCollection = z.looseObject({
  id: z.string(),
  name: z.string(),
  description: z.string().nullish(),
  sourceType: z.string().optional(),
  grouping: z.string().optional(),
  visibility: z.string().optional(),
  defaultIcon: z.string().nullish(),
  defaultEmoji: z.string().nullish(),
  defaultColor: z.string().nullish(),
});
export type MarkerCollection = z.infer<typeof MarkerCollection>;

export const MarkerEvent = z.looseObject({
  id: z.string(),
  collectionId: z.string(),
  timestamp: z.string(),
  title: z.string(),
  description: z.string().nullish(),
  emoji: z.string().nullish(),
  color: z.string().nullish(),
});
export type MarkerEvent = z.infer<typeof MarkerEvent>;
