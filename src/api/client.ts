import { z } from "zod";
import type { Config } from "../config";
import { log } from "../log";
import {
  AnomalyReport, Chart, Dashboard, type DATA_SOURCE_TYPES, DataSource, DataSourceCoverage, DownloadAnalytics, DownloadProvider,
  type DOWNLOAD_PROVIDERS, DownloadSearchHit, ErrorBucket, ErrorFilterMeta, ErrorIssue, ErrorIssueDetail, ErrorLabel,
  ErrorOccurrence, ErrorStackVariant, type ERROR_PRIORITIES, type ERROR_RESOLVE_MODES, type ERROR_STATUSES, type Flow, type MARKER_GROUPINGS, type MARKER_VISIBILITIES, MarkerCollection,
  MarkerEvent, type METRIC_SHAPES, PreviewResponse, ProjectPage, ProjectSummary, type Position, type QueryConfig, StructuredField,
} from "./types";

export class FastStatsError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly tag?: string,
  ) {
    super(message);
    this.name = "FastStatsError";
  }
}

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
type Query = Record<string, string | number | boolean | undefined>;

const RETRYABLE = new Set([429, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const TIMEOUT_MS = 30_000;

/** Project fields that must never leave the server (e.g. the ingest token). */
const PROJECT_REDACT = ["token", "codeContextConfig", "owner"] as const;

export interface CreateChartBody {
  name: string;
  chartType: string;
  query: Flow;
  dashboardId?: string | null;
  description?: string | null;
  queryConfig?: QueryConfig | null;
  position?: Position | null;
}

export type UpdateChartBody = Partial<CreateChartBody> & { expectedUpdatedAt?: string | null };

export interface CreateDataSourceBody {
  name: string;
  referenceId: string;
  dataType: (typeof DATA_SOURCE_TYPES)[number];
  metricShape: (typeof METRIC_SHAPES)[number];
  description?: string | null;
  regex?: string | null;
  allowNegative?: boolean | null;
  allowFloat?: boolean | null;
  minValue?: number | null;
  maxValue?: number | null;
}

/** FastStats requires metricShape on every PATCH. */
export type UpdateDataSourceBody = Partial<CreateDataSourceBody> & Pick<CreateDataSourceBody, "metricShape">;

export interface MarkerBody {
  /** ISO 8601, Unix seconds, or Unix milliseconds. */
  timestamp: string | number;
  title: string;
  description?: string | null;
  icon?: string | null;
  emoji?: string | null;
  color?: string | null;
  /** Stable id: creating a marker with an existing externalId updates it instead. */
  externalId?: string | null;
}

export interface MarkerCollectionPatch {
  name?: string;
  description?: string | null;
  defaultIcon?: string | null;
  defaultEmoji?: string | null;
  defaultColor?: string | null;
  grouping?: (typeof MARKER_GROUPINGS)[number] | null;
  visibility?: (typeof MARKER_VISIBILITIES)[number] | null;
}

type DownloadProviderName = (typeof DOWNLOAD_PROVIDERS)[number];

export interface ErrorQuery {
  /** Unix milliseconds (unverified: the spec only says "number"). */
  from?: number;
  to?: number;
  limit?: number;
  searchQuery?: string;
  status?: (typeof ERROR_STATUSES)[number];
  filters?: Array<{ field: string; operator: "equals" | "not_equals"; value: string }>;
}

export interface PreviewBody {
  chartType: string;
  queryConfig: QueryConfig;
  query: Flow;
}

export class FastStatsClient {
  private readonly projectCache = new Map<string, ProjectSummary>();

  constructor(
    private readonly config: Pick<Config, "apiKey" | "baseUrl">,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  // ---------- low level ----------

  async request<T>(method: Method, path: string, opts: { query?: Query; body?: unknown; schema?: z.ZodType<T> } = {}): Promise<T> {
    const url = new URL(this.config.baseUrl + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));

    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method,
          headers: {
            "x-api-key": this.config.apiKey,
            accept: "application/json",
            ...(opts.body === undefined ? {} : { "content-type": "application/json" }),
          },
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (err) {
        if (attempt < MAX_ATTEMPTS) {
          await sleep(backoff(attempt));
          continue;
        }
        throw new FastStatsError(0, `Network error calling FastStats (${method} ${path}): ${(err as Error).message}`);
      }

      if (RETRYABLE.has(res.status) && attempt < MAX_ATTEMPTS) {
        const retryAfter = Number(res.headers.get("retry-after"));
        const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff(attempt);
        log.warn(`HTTP ${res.status} on ${method} ${path}, retrying in ${wait}ms`);
        await sleep(wait);
        continue;
      }

      const text = await res.text();
      if (!res.ok) throw toError(res.status, text, method, path);
      if (!text || res.status === 204) return undefined as T;

      const json: unknown = JSON.parse(text);
      if (!opts.schema) return json as T;
      const parsed = opts.schema.safeParse(json);
      if (!parsed.success) {
        throw new FastStatsError(
          res.status,
          `FastStats returned an unexpected response shape for ${method} ${path} (the API may have changed): ${z.prettifyError(parsed.error)}`,
        );
      }
      return parsed.data;
    }
  }

  private p(project: string) {
    return `/v0/projects/${encodeURIComponent(project)}`;
  }

  // ---------- projects ----------

  async listProjects(opts: { search?: string } = {}): Promise<ProjectSummary[]> {
    const all: ProjectSummary[] = [];
    for (let offset = 0; ; ) {
      const page = await this.request("GET", "/v0/projects", {
        query: { limit: 100, offset, search: opts.search },
        schema: ProjectPage,
      });
      all.push(...page.items);
      if (!page.hasMore || page.items.length === 0) break;
      offset += page.items.length;
    }
    return all.map(redactProject);
  }

  async getProject(idOrSlug: string): Promise<ProjectSummary> {
    const cached = this.projectCache.get(idOrSlug);
    if (cached) return cached;
    const project = redactProject(await this.request("GET", this.p(idOrSlug), { schema: ProjectSummary }));
    this.projectCache.set(project.id, project);
    this.projectCache.set(project.slug, project);
    return project;
  }

  // ---------- data sources ----------

  listDataSources(project: string) {
    return this.request("GET", `${this.p(project)}/data-sources`, { schema: z.array(DataSource) });
  }

  getDataSourceCoverage(project: string) {
    return this.request("GET", `${this.p(project)}/data-sources/coverage`, { schema: DataSourceCoverage });
  }

  async getStructuredFields(project: string): Promise<StructuredField[]> {
    const res = await this.request("GET", `${this.p(project)}/data-sources/structured-fields`, {
      schema: z.looseObject({ fields: z.array(StructuredField) }),
    });
    return res.fields;
  }

  createDataSource(project: string, body: CreateDataSourceBody) {
    return this.request("POST", `${this.p(project)}/data-sources`, { body, schema: DataSource });
  }

  updateDataSource(project: string, dataSourceId: string, body: UpdateDataSourceBody) {
    return this.request("PATCH", `${this.p(project)}/data-sources/${encodeURIComponent(dataSourceId)}`, { body, schema: DataSource });
  }

  deleteDataSource(project: string, dataSourceId: string) {
    return this.request<void>("DELETE", `${this.p(project)}/data-sources/${encodeURIComponent(dataSourceId)}`);
  }

  // ---------- dashboards ----------

  listDashboards(project: string) {
    return this.request("GET", `${this.p(project)}/dashboards`, { schema: z.array(Dashboard) });
  }

  createDashboard(project: string, body: { name: string; description?: string | null; isPublic?: boolean }) {
    return this.request("POST", `${this.p(project)}/dashboards`, { body, schema: Dashboard });
  }

  updateDashboard(project: string, dashboardId: string, body: { name?: string; description?: string | null; isPublic?: boolean }) {
    return this.request("PATCH", `${this.p(project)}/dashboards/${encodeURIComponent(dashboardId)}`, { body, schema: Dashboard });
  }

  deleteDashboard(project: string, dashboardId: string) {
    return this.request<void>("DELETE", `${this.p(project)}/dashboards/${encodeURIComponent(dashboardId)}`);
  }

  duplicateDashboard(project: string, dashboardId: string) {
    return this.request("POST", `${this.p(project)}/dashboards/${encodeURIComponent(dashboardId)}/duplicate`, { schema: Dashboard });
  }

  copyDashboard(project: string, dashboardId: string, targetProjectId: string) {
    return this.request("POST", `${this.p(project)}/dashboards/${encodeURIComponent(dashboardId)}/copy`, {
      body: { targetProjectId },
      schema: Dashboard,
    });
  }

  reorderDashboards(project: string, dashboards: Array<{ id: string; position: number }>) {
    return this.request<void>("PUT", `${this.p(project)}/dashboards/order`, { body: { dashboards } });
  }

  // ---------- charts ----------

  listCharts(project: string, opts: { dashboardId?: string; chartId?: string } = {}) {
    return this.request("GET", `${this.p(project)}/charts`, { query: opts, schema: z.array(Chart) });
  }

  async getChart(project: string, chartId: string): Promise<Chart> {
    const [chart] = await this.listCharts(project, { chartId });
    if (!chart || chart.id !== chartId) throw new FastStatsError(404, `Chart ${chartId} not found in project ${project}`);
    return chart;
  }

  createChart(project: string, body: CreateChartBody) {
    return this.request("POST", `${this.p(project)}/charts`, { body, schema: z.looseObject({ id: z.string() }) });
  }

  updateChart(project: string, chartId: string, body: UpdateChartBody) {
    return this.request<void>("PATCH", `${this.p(project)}/charts/${encodeURIComponent(chartId)}`, { body });
  }

  deleteChart(project: string, chartId: string) {
    return this.request<void>("DELETE", `${this.p(project)}/charts/${encodeURIComponent(chartId)}`);
  }

  preview(project: string, body: PreviewBody) {
    return this.request("POST", `${this.p(project)}/metrics/preview`, { body, schema: PreviewResponse });
  }

  // ---------- event markers ----------

  listMarkerCollections(project: string) {
    return this.request("GET", `${this.p(project)}/event-marker-collections`, { schema: z.array(MarkerCollection) });
  }

  createMarkerCollection(project: string, body: { name: string; description?: string; defaultEmoji?: string; defaultColor?: string }) {
    return this.request("POST", `${this.p(project)}/event-marker-collections`, { body, schema: MarkerCollection });
  }

  updateMarkerCollection(project: string, collectionId: string, body: MarkerCollectionPatch) {
    return this.request("PATCH", `${this.p(project)}/event-marker-collections/${encodeURIComponent(collectionId)}`, { body, schema: MarkerCollection });
  }

  deleteMarkerCollection(project: string, collectionId: string) {
    return this.request<void>("DELETE", `${this.p(project)}/event-marker-collections/${encodeURIComponent(collectionId)}`);
  }

  listMarkers(project: string, collectionId: string, opts: { from?: string; to?: string; limit?: number } = {}) {
    return this.request("GET", `${this.p(project)}/event-marker-collections/${encodeURIComponent(collectionId)}/events`, {
      query: opts,
      schema: z.array(MarkerEvent),
    });
  }

  createMarker(project: string, collectionId: string, body: MarkerBody) {
    return this.request("POST", `${this.p(project)}/event-marker-collections/${encodeURIComponent(collectionId)}/events`, {
      body,
      schema: MarkerEvent,
    });
  }

  bulkCreateMarkers(project: string, collectionId: string, events: MarkerBody[]) {
    return this.request("POST", `${this.p(project)}/event-marker-collections/${encodeURIComponent(collectionId)}/events/bulk`, {
      body: { events },
      schema: z.array(MarkerEvent),
    });
  }

  updateMarker(project: string, collectionId: string, eventId: string, body: Partial<MarkerBody>) {
    return this.request(
      "PATCH",
      `${this.p(project)}/event-marker-collections/${encodeURIComponent(collectionId)}/events/${encodeURIComponent(eventId)}`,
      { body, schema: MarkerEvent },
    );
  }

  deleteMarker(project: string, collectionId: string, eventId: string) {
    return this.request<void>(
      "DELETE",
      `${this.p(project)}/event-marker-collections/${encodeURIComponent(collectionId)}/events/${encodeURIComponent(eventId)}`,
    );
  }

  // ---------- error tracking ----------

  /** Issues for one project, or across several when projectIds is given (POST /v0/errors/issues/query). */
  queryErrorIssues(target: { project: string } | { projectIds: string[] }, body: ErrorQuery) {
    return "project" in target
      ? this.request("POST", `${this.p(target.project)}/errors/issues/query`, { body, schema: z.array(ErrorIssue) })
      : this.request("POST", "/v0/errors/issues/query", { body: { ...body, projectIds: target.projectIds }, schema: z.array(ErrorIssue) });
  }

  queryErrorTimeseries(target: { project: string } | { projectIds: string[] }, body: ErrorQuery) {
    return "project" in target
      ? this.request("POST", `${this.p(target.project)}/errors/timeseries/query`, { body, schema: z.array(ErrorBucket) })
      : this.request("POST", "/v0/errors/timeseries/query", { body: { ...body, projectIds: target.projectIds }, schema: z.array(ErrorBucket) });
  }

  getErrorIssue(project: string, errorId: string) {
    return this.request("GET", `${this.p(project)}/errors/issues/${encodeURIComponent(errorId)}`, { schema: ErrorIssueDetail });
  }

  listErrorOccurrences(project: string, errorId: string, limit: number) {
    return this.request("GET", `${this.p(project)}/errors/issues/${encodeURIComponent(errorId)}/occurrences`, {
      query: { limit },
      schema: z.array(ErrorOccurrence),
    });
  }

  listErrorStackVariants(project: string, errorId: string, limit: number) {
    return this.request("GET", `${this.p(project)}/errors/issues/${encodeURIComponent(errorId)}/stacktrace-variants`, {
      query: { limit },
      schema: z.array(ErrorStackVariant),
    });
  }

  getErrorFilterMeta(project: string) {
    return this.request("GET", `${this.p(project)}/errors/filters`, { schema: ErrorFilterMeta });
  }

  listErrorLabels(project: string) {
    return this.request("GET", `${this.p(project)}/errors/labels`, { query: { includeCounts: true }, schema: z.array(ErrorLabel) });
  }

  updateErrorIssue(project: string, errorId: string, body: { priority?: (typeof ERROR_PRIORITIES)[number] | null; assigneeId?: string | null }) {
    return this.request<void>("PATCH", `${this.p(project)}/errors/issues/${encodeURIComponent(errorId)}`, { body });
  }

  setErrorLabels(project: string, errorId: string, labelIds: string[]) {
    return this.request<void>("PUT", `${this.p(project)}/errors/issues/${encodeURIComponent(errorId)}/labels`, { body: { labelIds } });
  }

  resolveErrors(projectId: string, errorIds: string[], mode: (typeof ERROR_RESOLVE_MODES)[number], note?: string) {
    return this.request<void>("POST", "/v0/errors/resolve", { body: { projects: [{ projectId, errorIds }], mode, note } });
  }

  reopenErrors(project: string, errorIds: string[]) {
    return this.request<void>("POST", `${this.p(project)}/errors/resolutions/clear`, { body: { errorIds } });
  }

  markErrorsViewed(project: string, ids: string[]) {
    return this.request<void>("POST", `${this.p(project)}/errors/issues/viewed`, { body: { ids } });
  }

  mergeErrors(project: string, primaryErrorId: string, mergedErrorIds: string[]) {
    return this.request("POST", `${this.p(project)}/errors/issues/merge`, {
      body: { primaryErrorId, mergedErrorIds },
      schema: z.looseObject({ primaryErrorId: z.string() }),
    });
  }

  deleteErrors(project: string, ids: string[]) {
    return this.request("POST", `${this.p(project)}/errors/issues/delete`, {
      body: { ids },
      schema: z.looseObject({ ids: z.array(z.string()), pending: z.boolean().nullish() }),
    });
  }

  // ---------- health ----------

  async checkProjectData(project: string): Promise<boolean> {
    return this.request("GET", `${this.p(project)}/check-data`, { schema: z.boolean() });
  }

  getAnomalies(project: string, opts: { grain?: "hour" | "day"; at?: string } = {}) {
    return this.request("GET", `${this.p(project)}/anomalies`, { query: opts, schema: AnomalyReport });
  }

  // ---------- downloads ----------

  getDownloadAnalytics(
    project: string,
    opts: { dateFrom?: string; dateTo?: string; provider?: DownloadProviderName; versionNumber?: string; granularity?: "day" | "30min" } = {},
  ) {
    return this.request("GET", `${this.p(project)}/downloads`, { query: opts, schema: DownloadAnalytics });
  }

  listDownloadProviders(project: string) {
    return this.request("GET", `${this.p(project)}/download-providers`, { schema: z.array(DownloadProvider) });
  }

  searchDownloadProviders(project: string, provider: DownloadProviderName, query: string) {
    return this.request("GET", `${this.p(project)}/download-providers/search`, { query: { provider, query }, schema: z.array(DownloadSearchHit) });
  }

  createDownloadProvider(project: string, body: { provider: DownloadProviderName; externalId: string }) {
    return this.request("POST", `${this.p(project)}/download-providers`, { body, schema: DownloadProvider });
  }

  deleteDownloadProvider(project: string, providerId: string) {
    return this.request<void>("DELETE", `${this.p(project)}/download-providers/${encodeURIComponent(providerId)}`);
  }
}

function redactProject<T extends Record<string, unknown>>(p: T): T {
  const copy: Record<string, unknown> = { ...p };
  for (const k of PROJECT_REDACT) delete copy[k];
  return copy as T;
}

function toError(status: number, text: string, method: string, path: string): FastStatsError {
  let message = text.slice(0, 500) || `HTTP ${status}`;
  let tag: string | undefined;
  try {
    const j = JSON.parse(text) as { message?: unknown; _tag?: unknown; error?: unknown };
    if (typeof j.message === "string") message = j.message;
    else if (typeof j.error === "string") message = j.error;
    if (typeof j._tag === "string") tag = j._tag;
  } catch {
    /* not JSON */
  }
  const hint =
    status === 401 ? " (check FASTSTATS_API_KEY)" :
    status === 403
      ? /session/i.test(message)
        ? " (FastStats only allows this endpoint for a logged-in user, not an API key, so the key's permissions can't fix it)"
        : " (the API key lacks access to this project)" :
    status === 409 ? " (someone changed this chart since it was read; fetch it again)" : "";
  return new FastStatsError(status, `FastStats ${method} ${path} failed with ${status}${tag ? ` ${tag}` : ""}: ${message}${hint}`, tag);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const backoff = (attempt: number) => 500 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
