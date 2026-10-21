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

export const DATA_SOURCE_TYPES = ["number", "string", "boolean", "json"] as const;
export const METRIC_SHAPES = ["scalar", "array", "map"] as const;

// FastStats encodes non-finite numbers as the strings "Infinity", "-Infinity" and "NaN".
const num = z.union([z.number(), z.string()]);

export const DataSource = z.looseObject({
  id: z.string(),
  name: z.string(),
  description: z.string().nullish(),
  referenceId: z.string(),
  dataType: z.string(),
  metricShape: z.string().nullish(),
  isArray: z.boolean().nullish(),
  regex: z.string().nullish(),
  allowNegative: z.boolean().nullish(),
  allowFloat: z.boolean().nullish(),
  minValue: num.nullish(),
  maxValue: num.nullish(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});
export type DataSource = z.infer<typeof DataSource>;

export const DataSourceCoverage = z.looseObject({
  fromTime: num,
  toTime: num,
  totalEvents: num,
  sources: z.array(z.looseObject({ referenceId: z.string(), eventCount: num, percentage: num })),
});
export type DataSourceCoverage = z.infer<typeof DataSourceCoverage>;

export const StructuredField = z.looseObject({
  sourceReferenceId: z.string(),
  path: z.array(z.string()),
  dataType: z.string(),
  observedTypes: z.array(z.string()).optional(),
  observedCount: num.optional(),
  firstSeenAt: z.string().nullish(),
  lastSeenAt: z.string().nullish(),
  sampleValue: z.string().nullish(),
});
export type StructuredField = z.infer<typeof StructuredField>;

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
  icon: z.string().nullish(),
  emoji: z.string().nullish(),
  color: z.string().nullish(),
  externalId: z.string().nullish(),
  metadata: z.record(z.string(), z.unknown()).nullish(),
});
export type MarkerEvent = z.infer<typeof MarkerEvent>;

export const MARKER_GROUPINGS = ["auto", "minute", "hour", "day", "week", "chart_bucket"] as const;
export const MARKER_VISIBILITIES = ["private", "project", "public"] as const;

export const AnomalyReport = z.looseObject({
  grain: z.string(),
  from: num,
  to: num,
  health: z.array(z.looseObject({ metric: z.string(), label: z.string(), status: z.string() })),
  incidents: z.array(z.looseObject({ id: z.string(), kind: z.string(), severity: z.string(), title: z.string() })),
});
export type AnomalyReport = z.infer<typeof AnomalyReport>;

export const DOWNLOAD_PROVIDERS = ["modrinth", "spigot", "hangar", "ore", "curseforge", "github"] as const;

export const DownloadProvider = z.looseObject({
  id: z.string(),
  provider: z.string(),
  externalId: z.string(),
  title: z.string(),
  slug: z.string().nullish(),
  url: z.string().nullish(),
  totalDownloads: num.optional(),
  lastSyncedAt: z.string().nullish(),
});
export type DownloadProvider = z.infer<typeof DownloadProvider>;

export const DownloadSearchHit = z.looseObject({
  provider: z.string(),
  externalId: z.string(),
  title: z.string(),
  slug: z.string().nullish(),
  url: z.string().nullish(),
  summary: z.string().nullish(),
  totalDownloads: num.optional(),
});

export const DownloadAnalytics = z.looseObject({
  overview: z.looseObject({ totalDownloads: num }),
  history: z.array(z.looseObject({ bucket: z.string(), downloads: num, gained: num.optional(), provider: z.string().nullish() })),
  providerBreakdown: z.array(z.looseObject({})).optional(),
  providerSummaries: z.array(z.looseObject({ provider: z.string(), downloads: num })),
  versions: z.array(z.looseObject({ provider: z.string(), versionNumber: z.string(), downloads: num, releaseDate: z.string().nullish() })),
});
export type DownloadAnalytics = z.infer<typeof DownloadAnalytics>;

export const ERROR_STATUSES = ["active", "resolved", "all"] as const;
export const ERROR_PRIORITIES = ["critical", "high", "medium", "low"] as const;
export const ERROR_RESOLVE_MODES = ["once", "version", "version_and_prior", "forever"] as const;

export const ErrorLabel = z.looseObject({ id: z.string(), name: z.string(), color: z.string().optional(), issueCount: num.nullish() });
export type ErrorLabel = z.infer<typeof ErrorLabel>;

export const ErrorIssue = z.looseObject({
  id: z.string(),
  projectId: z.string(),
  errorId: z.string(),
  errorName: z.string(),
  errorMessage: z.string(),
  language: z.string().nullish(),
  latestStack: z.array(z.string()).optional(),
  mappedLatestStack: z.array(z.string()).optional(),
  occurrenceCount: num,
  affectedSessionCount: num.optional(),
  firstOccurred: z.string(),
  lastOccurred: z.string(),
  pluginVersion: z.string().nullish(),
  firstPluginVersion: z.string().nullish(),
  affectedVersions: z.array(z.string()).optional(),
  viewed: z.boolean().optional(),
  status: z.string().optional(),
  regressed: z.boolean().optional(),
  priority: z.string().nullish(),
  assigneeId: z.string().nullish(),
  assigneeName: z.string().nullish(),
  labels: z.array(ErrorLabel).optional(),
  commentCount: num.optional(),
  resolution: z.looseObject({ mode: z.string(), resolvedAt: z.string().optional(), note: z.string().nullish() }).nullish(),
});
export type ErrorIssue = z.infer<typeof ErrorIssue>;

export const ErrorBucket = z.looseObject({ date: z.string(), errors: num, uniqueErrors: num.optional(), bucketStart: z.string().optional() });

export const ErrorIssueDetail = z.looseObject({
  issue: ErrorIssue,
  timeline: z.array(ErrorBucket).optional(),
});

export const ErrorOccurrence = z.looseObject({
  id: z.string(),
  createdAt: z.string(),
  latestStack: z.array(z.string()).optional(),
  mappedStack: z.array(z.string()).optional(),
  context: z.unknown().optional(),
});

export const ErrorStackVariant = z.looseObject({
  id: z.string(),
  stack: z.array(z.string()),
  occurrenceCount: num,
});

export const ErrorFilterMeta = z.record(z.string(), z.array(z.string()).nullish());
