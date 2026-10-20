import { z } from "zod";
import type { Config } from "../config";
import { log } from "../log";
import {
  Chart, Dashboard, DataSource, type Flow, MarkerCollection, MarkerEvent, PreviewResponse,
  ProjectPage, ProjectSummary, type Position, type QueryConfig,
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

  // ---------- dashboards ----------

  listDashboards(project: string) {
    return this.request("GET", `${this.p(project)}/dashboards`, { schema: z.array(Dashboard) });
  }

  createDashboard(project: string, body: { name: string; description?: string | null; isPublic?: boolean }) {
    return this.request("POST", `${this.p(project)}/dashboards`, { body, schema: Dashboard });
  }

  updateDashboard(project: string, dashboardId: string, body: { name?: string; description?: string | null; isPublic?: boolean }) {
    return this.request<unknown>("PATCH", `${this.p(project)}/dashboards/${encodeURIComponent(dashboardId)}`, { body });
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

  listMarkers(project: string, collectionId: string, opts: { from?: string; to?: string; limit?: number } = {}) {
    return this.request("GET", `${this.p(project)}/event-marker-collections/${encodeURIComponent(collectionId)}/events`, {
      query: opts,
      schema: z.array(MarkerEvent),
    });
  }

  createMarker(
    project: string,
    collectionId: string,
    body: { timestamp: string; title: string; description?: string; emoji?: string; color?: string },
  ) {
    return this.request("POST", `${this.p(project)}/event-marker-collections/${encodeURIComponent(collectionId)}/events`, {
      body,
      schema: MarkerEvent,
    });
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
    status === 403 ? " (the API key lacks access to this project)" :
    status === 409 ? " (someone changed this chart since it was read; fetch it again)" : "";
  return new FastStatsError(status, `FastStats ${method} ${path} failed with ${status}${tag ? ` ${tag}` : ""}: ${message}${hint}`, tag);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const backoff = (attempt: number) => 500 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
