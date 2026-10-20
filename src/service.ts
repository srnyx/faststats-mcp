import { type FastStatsClient, FastStatsError } from "./api/client";
import type { Chart, Dashboard, DataSource, MarkerCollection, Position, ProjectSummary } from "./api/types";
import { compile, type CompileResult } from "./flow/compile";
import { FieldCatalog } from "./flow/fields";
import type { ChartSpec } from "./flow/spec";
import { defaultSize, place, type Rect, toRect } from "./layout/grid";

export class UserError extends Error {
  override name = "UserError";
}

export interface PreviewOutcome {
  ok: boolean;
  errors: string[];
  warnings: string[];
  outputs?: string[];
  sample?: unknown;
  compiled: CompileResult;
}

export class FastStatsService {
  constructor(
    readonly api: FastStatsClient,
    private readonly defaultProject?: string,
  ) {}

  project(p?: string): Promise<ProjectSummary> {
    const id = p?.trim() || this.defaultProject;
    if (!id) throw new UserError("No project given. Pass `project` (slug or id), or set FASTSTATS_DEFAULT_PROJECT. Use list_projects to find slugs.");
    return this.api.getProject(id);
  }

  async catalog(project: ProjectSummary): Promise<FieldCatalog> {
    return new FieldCatalog(project.templateId, await this.api.listDataSources(project.id));
  }

  defaultDashboardId(project: ProjectSummary) {
    return `default:${project.id}`;
  }

  /** Accepts a dashboard id, its exact name (case-insensitive), or "default". */
  async resolveDashboard(project: ProjectSummary, ref: string): Promise<{ id: string; name: string }> {
    const r = ref.trim();
    if (r.toLowerCase() === "default" || r === this.defaultDashboardId(project)) {
      return { id: this.defaultDashboardId(project), name: "Default dashboard" };
    }
    const dashboards = await this.api.listDashboards(project.id);
    const hit =
      dashboards.find((d) => d.id === r) ??
      dashboards.find((d) => d.name.toLowerCase() === r.toLowerCase());
    if (!hit) {
      throw new UserError(
        `Dashboard "${ref}" not found. Existing: ${dashboards.map((d) => `"${d.name}"`).join(", ") || "none"}. ` +
          `Use create_dashboard to make a new one.`,
      );
    }
    return { id: hit.isDefault ? this.defaultDashboardId(project) : hit.id, name: hit.name };
  }

  async preview(project: ProjectSummary, spec: ChartSpec, catalog?: FieldCatalog): Promise<PreviewOutcome> {
    const compiled = compile(spec, catalog ?? (await this.catalog(project)));
    if (compiled.errors.length) return { ok: false, errors: compiled.errors, warnings: compiled.warnings, compiled };
    try {
      const res = await this.api.preview(project.id, {
        chartType: spec.chartType,
        queryConfig: compiled.queryConfig,
        query: compiled.flow,
      });
      const outputs = res.flowMeta.outputs.map((o) => o.name);
      const errors: string[] = [];
      if (outputs.length !== compiled.outputCount) {
        errors.push(
          `FastStats produced ${outputs.length} of ${compiled.outputCount} outputs. ` +
            `This usually means a formula references a missing input or a pipeline is incompatible with the chart type.`,
        );
      }
      return { ok: errors.length === 0, errors, warnings: compiled.warnings, outputs, sample: trim(res.data), compiled };
    } catch (err) {
      if (err instanceof FastStatsError && err.status >= 400 && err.status < 600) {
        return { ok: false, errors: [err.message], warnings: compiled.warnings, compiled };
      }
      throw err;
    }
  }

  async occupied(project: ProjectSummary, dashboardId: string, exceptChartId?: string): Promise<Rect[]> {
    const charts = await this.api.listCharts(project.id, { dashboardId });
    return charts
      .filter((c) => c.dashboardId === dashboardId && c.id !== exceptChartId)
      .map((c) => toRect(c.position))
      .filter((r): r is Rect => r !== undefined);
  }

  positionFor(spec: Pick<ChartSpec, "chartType" | "size">, occupied: Rect[], explicit?: Position): Position {
    if (explicit) {
      occupied.push(explicit);
      return explicit;
    }
    return place(occupied, spec.size ?? defaultSize(spec.chartType));
  }

  /** A stored (non-default) dashboard by id or exact name, for renames, deletes and reordering. */
  async resolveStoredDashboard(project: ProjectSummary, ref: string, dashboards?: Dashboard[]): Promise<Dashboard> {
    const r = ref.trim();
    const list = dashboards ?? (await this.api.listDashboards(project.id));
    const hit = list.find((d) => d.id === r) ?? list.find((d) => d.name.toLowerCase() === r.toLowerCase());
    if (r.toLowerCase() === "default" || r === this.defaultDashboardId(project) || hit?.isDefault) {
      throw new UserError("The default dashboard can't be renamed, deleted or reordered.");
    }
    if (!hit) throw new UserError(`Dashboard "${ref}" not found. Existing: ${list.map((d) => `"${d.name}"`).join(", ") || "none"}.`);
    return hit;
  }

  /** A marker collection by id or name (case-insensitive); with create, a missing name is created. */
  async resolveMarkerCollection(project: ProjectSummary, ref: { collectionId?: string; collectionName?: string }, create = false): Promise<MarkerCollection> {
    if (!ref.collectionId && !ref.collectionName) throw new UserError("Pass collectionId or collectionName.");
    const list = await this.api.listMarkerCollections(project.id);
    const hit = ref.collectionId
      ? list.find((c) => c.id === ref.collectionId)
      : list.find((c) => c.name.toLowerCase() === ref.collectionName!.toLowerCase());
    if (hit) return hit;
    if (create && ref.collectionName) return this.api.createMarkerCollection(project.id, { name: ref.collectionName });
    throw new UserError(
      `Marker collection "${ref.collectionId ?? ref.collectionName}" not found. Existing: ${list.map((c) => `"${c.name}" (${c.id})`).join(", ") || "none"}.`,
    );
  }

  /** Accepts a data source id or its referenceId. */
  async resolveDataSource(project: ProjectSummary, ref: string): Promise<DataSource> {
    const r = ref.trim();
    const sources = await this.api.listDataSources(project.id);
    const hit = sources.find((s) => s.id === r) ?? sources.find((s) => s.referenceId === r);
    if (!hit) {
      throw new UserError(
        `Data source "${ref}" not found. Existing: ${sources.map((s) => s.referenceId).join(", ") || "none"}.`,
      );
    }
    return hit;
  }

  /** Charts whose flow references the field, directly or through a dot path into it. */
  async chartsUsing(project: ProjectSummary, referenceId: string): Promise<Array<{ id: string; name: string; dashboardId: string }>> {
    const charts = await this.api.listCharts(project.id);
    return charts
      .filter((c) => c.query.nodes.some((n) => mentions(n.data, referenceId)))
      .map((c) => ({ id: c.id, name: c.name, dashboardId: c.dashboardId }));
  }

  async chartsByDashboard(project: ProjectSummary): Promise<{ dashboards: Dashboard[]; charts: Chart[] }> {
    const [dashboards, charts] = await Promise.all([this.api.listDashboards(project.id), this.api.listCharts(project.id)]);
    return { dashboards, charts };
  }
}

function mentions(v: unknown, field: string): boolean {
  if (typeof v === "string") return v === field || v.startsWith(field + ".");
  if (Array.isArray(v)) return v.some((x) => mentions(x, field));
  if (v && typeof v === "object") return Object.values(v).some((x) => mentions(x, field));
  return false;
}

/** Keeps preview samples small enough to be useful in a tool result. */
export function trim(v: unknown, depth = 0): unknown {
  if (Array.isArray(v)) {
    const head = v.slice(0, 8).map((x) => trim(x, depth + 1));
    return v.length > 8 ? [...head, `… ${v.length - 8} more`] : head;
  }
  if (v && typeof v === "object") {
    if (depth > 4) return "{…}";
    return Object.fromEntries(Object.entries(v).slice(0, 25).map(([k, x]) => [k, trim(x, depth + 1)]));
  }
  if (typeof v === "string" && v.length > 200) return v.slice(0, 200) + "…";
  return v;
}
