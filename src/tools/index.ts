import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type Dashboard, DATA_SOURCE_TYPES, DOWNLOAD_PROVIDERS, MARKER_GROUPINGS, MARKER_VISIBILITIES, METRIC_SHAPES, Position } from "../api/types";
import { decompileChart } from "../flow/decompile";
import { ChartSpec, Size } from "../flow/spec";
import guide from "../resources/guide.md";
import { type FastStatsService, UserError } from "../service";
import { registerErrorTools } from "./errors";
import { defined, fail, guard, iso, ok, projectArg, RO } from "./util";

/** Optional data source fields shared by create and update; null clears a value. */
const DataSourceFields = {
  description: z.string().nullable().optional(),
  regex: z.string().nullable().optional().describe("Incoming string values must match this"),
  allowNegative: z.boolean().nullable().optional(),
  allowFloat: z.boolean().nullable().optional(),
  minValue: z.number().nullable().optional(),
  maxValue: z.number().nullable().optional(),
};

/** Marker fields shared by single, bulk and update calls. */
const MarkerFields = {
  timestamp: z.union([z.string(), z.number()]).describe("ISO 8601, or Unix seconds/milliseconds"),
  title: z.string().min(1),
  description: z.string().nullable().optional(),
  icon: z.string().nullable().optional(),
  emoji: z.string().nullable().optional(),
  color: z.string().nullable().optional(),
  externalId: z.string().nullable().optional().describe("Stable id (e.g. the version); reusing it updates that marker instead of adding one"),
};

const partialShape = <S extends Record<string, z.ZodType>>(shape: S) =>
  Object.fromEntries(Object.entries(shape).map(([k, v]) => [k, v.optional()])) as { [K in keyof S]: z.ZodOptional<S[K]> };

/** Strips per-bucket chart arrays from anomaly results; they are large and not useful in text. */
const withoutSeries = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(withoutSeries);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).filter(([k]) => k !== "chart").map(([k, x]) => [k, withoutSeries(x)]));
  return v;
};

export function registerTools(server: McpServer, svc: FastStatsService, opts: { readOnly: boolean }) {

  // ---------------- read ----------------

  server.registerTool(
    "get_guide",
    {
      title: "Chart design guide",
      description: "The chart spec format, step reference, semantics and recipes. Read this before designing charts for the first time.",
      annotations: RO,
    },
    async () => ok(guide),
  );

  server.registerTool(
    "list_projects",
    {
      title: "List projects",
      description: "Lists FastStats projects the API key can access (slug, name, id, template).",
      inputSchema: { search: z.string().optional().describe("Filter by name") },
      annotations: RO,
    },
    guard("list_projects", async ({ search }) => {
      const projects = await svc.api.listProjects({ search });
      return ok(projects.map((p) => ({ slug: p.slug, name: p.name, id: p.id, template: p.templateId ?? null, firstEventAt: p.firstEventAt ?? null })));
    }),
  );

  server.registerTool(
    "get_project_context",
    {
      title: "Get project context",
      description:
        "Everything needed to design charts for one project: available fields (built-in internal:* and custom metrics, with type and shape), dashboards, and existing charts per dashboard.",
      inputSchema: { project: projectArg },
      annotations: RO,
    },
    guard("get_project_context", async ({ project }) => {
      const p = await svc.project(project);
      const [catalog, { dashboards, charts }] = await Promise.all([svc.catalog(p), svc.chartsByDashboard(p)]);
      const defaultId = svc.defaultDashboardId(p);
      const dashList = [
        { id: defaultId, name: "Default dashboard", isDefault: true },
        ...dashboards.filter((d) => !d.isDefault).map((d) => ({ id: d.id, name: d.name, description: d.description ?? undefined, isPublic: d.isPublic })),
      ];
      return ok({
        project: { slug: p.slug, name: p.name, id: p.id, template: p.templateId ?? null, firstEventAt: p.firstEventAt ?? null },
        fields: {
          custom: catalog.all().filter((f) => f.kind === "custom").map(({ kind: _k, ...f }) => f),
          internal: catalog.all().filter((f) => f.kind === "internal").map((f) => `${f.id} (${f.dataType}${f.shape !== "scalar" ? `, ${f.shape}` : ""})`),
        },
        dashboards: dashList.map((d) => ({
          ...d,
          charts: charts
            .filter((c) => c.dashboardId === d.id)
            .map((c) => ({ id: c.id, name: c.name, type: c.chartType, position: c.position ?? null })),
        })),
        tip: "Call get_guide for the spec format if you have not yet.",
      });
    }),
  );

  server.registerTool(
    "get_chart",
    {
      title: "Get chart",
      description: "Returns one chart as an editable spec (the same format create/update take). Pass includeFlow to also get the raw stored flow graph.",
      inputSchema: { project: projectArg, chartId: z.string(), includeFlow: z.boolean().optional() },
      annotations: RO,
    },
    guard("get_chart", async ({ project, chartId, includeFlow }) => {
      const p = await svc.project(project);
      const chart = await svc.api.getChart(p.id, chartId);
      const { spec, warnings } = decompileChart(chart);
      return ok({
        id: chart.id,
        dashboardId: chart.dashboardId,
        position: chart.position ?? null,
        updatedAt: chart.updatedAt,
        spec,
        ...(warnings.length ? { warnings } : {}),
        ...(includeFlow ? { flow: chart.query, queryConfig: chart.queryConfig } : {}),
      });
    }),
  );

  server.registerTool(
    "preview_chart",
    {
      title: "Preview chart",
      description:
        "Compiles a chart spec, validates fields and formulas, and runs it on FastStats without saving. Returns ok, errors, warnings, output names and a trimmed data sample.",
      inputSchema: { project: projectArg, spec: ChartSpec },
      annotations: RO,
    },
    guard("preview_chart", async ({ project, spec }) => {
      const p = await svc.project(project);
      const r = await svc.preview(p, spec);
      return ok({ ok: r.ok, errors: r.errors, warnings: r.warnings, outputs: r.outputs, sample: r.sample });
    }),
  );

  server.registerTool(
    "list_event_markers",
    {
      title: "List event markers",
      description: "Without collectionId: lists marker collections (use their ids in a spec's markerCollections). With collectionId: lists that collection's markers.",
      inputSchema: {
        project: projectArg,
        collectionId: z.string().optional(),
        from: z.string().optional().describe("ISO timestamp"),
        to: z.string().optional().describe("ISO timestamp"),
      },
      annotations: RO,
    },
    guard("list_event_markers", async ({ project, collectionId, from, to }) => {
      const p = await svc.project(project);
      if (!collectionId) return ok(await svc.api.listMarkerCollections(p.id));
      return ok(await svc.api.listMarkers(p.id, collectionId, { from, to, limit: 200 }));
    }),
  );

  server.registerTool(
    "list_data_sources",
    {
      title: "List data sources",
      description:
        "Lists the project's custom metrics (data sources) with their full config and ids. coverage adds how many events report each metric, plus metrics sent but not registered. structuredFields adds the nested paths observed inside json metrics.",
      inputSchema: {
        project: projectArg,
        coverage: z.boolean().optional().describe("Include event counts per metric"),
        structuredFields: z.boolean().optional().describe("Include observed dot paths of json metrics"),
      },
      annotations: RO,
    },
    guard("list_data_sources", async ({ project, coverage, structuredFields }) => {
      const p = await svc.project(project);
      const [sources, cov, fields] = await Promise.all([
        svc.api.listDataSources(p.id),
        coverage ? svc.api.getDataSourceCoverage(p.id) : undefined,
        structuredFields ? svc.api.getStructuredFields(p.id) : undefined,
      ]);
      const covByRef = new Map(cov?.sources.map((s) => [s.referenceId, s]));
      const known = new Set(sources.map((s) => s.referenceId));
      return ok({
        sources: sources.map((s) => {
          const c = covByRef.get(s.referenceId);
          return {
            ...s,
            ...(cov ? { eventCount: c?.eventCount ?? 0, percentage: c?.percentage ?? 0 } : {}),
            ...(fields
              ? {
                  fields: fields
                    .filter((f) => f.sourceReferenceId === s.referenceId)
                    .map((f) => ({ path: [s.referenceId, ...f.path].join("."), dataType: f.dataType, observedCount: f.observedCount, sample: f.sampleValue ?? null })),
                }
              : {}),
          };
        }),
        ...(cov
          ? {
              coverage: {
                fromTime: cov.fromTime,
                toTime: cov.toTime,
                totalEvents: cov.totalEvents,
                unregistered: cov.sources.filter((s) => !known.has(s.referenceId)),
              },
            }
          : {}),
      });
    }),
  );

  server.registerTool(
    "check_project_data",
    {
      title: "Check project data",
      description: "Whether the project has received any data yet, i.e. whether the plugin or site is reporting.",
      inputSchema: { project: projectArg },
      annotations: RO,
    },
    guard("check_project_data", async ({ project }) => {
      const p = await svc.project(project);
      const hasData = await svc.api.checkProjectData(p.id);
      return ok({
        project: p.slug,
        hasData,
        firstEventAt: p.firstEventAt ?? null,
        ...(hasData ? {} : { hint: "No data yet. Check that the plugin/site is installed with this project's token and has run for a few minutes." }),
      });
    }),
  );

  server.registerTool(
    "get_anomalies",
    {
      title: "Get anomalies",
      description:
        "FastStats' anomaly detection for the project: metric health (current vs expected) and incidents (spikes, shifts, gaps) with likely causes such as releases or event markers.",
      inputSchema: {
        project: projectArg,
        grain: z.enum(["hour", "day"]).optional().describe("Bucket size; defaults to FastStats' choice"),
        at: z.string().optional().describe("ISO timestamp to evaluate at instead of now"),
        includeNormal: z.boolean().optional().describe("Also list metrics whose health is normal"),
      },
      annotations: RO,
    },
    guard("get_anomalies", async ({ project, grain, at, includeNormal }) => {
      const p = await svc.project(project);
      const r = await svc.api.getAnomalies(p.id, { grain, at });
      const health = r.health.filter((h) => includeNormal || h.status !== "normal");
      return ok({
        ...(withoutSeries(r) as object),
        from: iso(r.from),
        to: iso(r.to),
        health: health.map(withoutSeries),
        ...(includeNormal ? {} : { normalMetrics: r.health.length - health.length }),
      });
    }),
  );

  server.registerTool(
    "get_download_analytics",
    {
      title: "Get download analytics",
      description:
        "Downloads from linked platforms (Modrinth, Spigot, Hangar, Ore, CurseForge, GitHub): totals, per platform, per version, and the linked listings. includeHistory adds the time series.",
      inputSchema: {
        project: projectArg,
        dateFrom: z.string().optional().describe("ISO date"),
        dateTo: z.string().optional().describe("ISO date"),
        provider: z.enum(DOWNLOAD_PROVIDERS).optional(),
        versionNumber: z.string().optional(),
        granularity: z.enum(["day", "30min"]).optional(),
        includeHistory: z.boolean().optional(),
        versionLimit: z.number().int().min(1).max(500).optional().describe("Top versions by downloads to return (default 25)"),
      },
      annotations: RO,
    },
    guard("get_download_analytics", async ({ project, includeHistory, versionLimit = 25, ...query }) => {
      const p = await svc.project(project);
      const [r, linked] = await Promise.all([svc.api.getDownloadAnalytics(p.id, query), svc.api.listDownloadProviders(p.id)]);
      const versions = [...r.versions].sort((a, b) => Number(b.downloads) - Number(a.downloads));
      return ok({
        overview: r.overview,
        providers: r.providerSummaries,
        versions: versions.slice(0, versionLimit),
        ...(versions.length > versionLimit ? { moreVersions: versions.length - versionLimit } : {}),
        ...(includeHistory ? { history: r.history } : {}),
        linked: linked.map((d) => ({ id: d.id, provider: d.provider, externalId: d.externalId, slug: d.slug ?? null, title: d.title, url: d.url ?? null, lastSyncedAt: d.lastSyncedAt ?? null })),
        ...(linked.length ? {} : { hint: "No platforms linked. Use search_download_providers, then link_download_provider." }),
      });
    }),
  );

  server.registerTool(
    "search_download_providers",
    {
      title: "Search download providers",
      description: "Finds a plugin's listing on a download platform, to get the externalId for link_download_provider.",
      inputSchema: { project: projectArg, provider: z.enum(DOWNLOAD_PROVIDERS), query: z.string().min(1).describe("Plugin name or slug") },
      annotations: RO,
    },
    guard("search_download_providers", async ({ project, provider, query }) => {
      const p = await svc.project(project);
      return ok(await svc.api.searchDownloadProviders(p.id, provider, query));
    }),
  );

  registerErrorTools(server, svc, opts);

  if (opts.readOnly) return;

  // ---------------- write ----------------

  server.registerTool(
    "create_chart",
    {
      title: "Create chart",
      description:
        "Previews the spec and, only if it is valid, saves it to an existing dashboard (id, exact name, or \"default\"). Places it in the first free grid slot unless position is given.",
      inputSchema: {
        project: projectArg,
        dashboard: z.string().describe("Dashboard id, exact name, or \"default\""),
        spec: ChartSpec,
        position: Position.optional().describe("Explicit grid position {x,y,w,h}; overrides spec.size"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    guard("create_chart", async ({ project, dashboard, spec, position }) => {
      const p = await svc.project(project);
      const dash = await svc.resolveDashboard(p, dashboard);
      const pre = await svc.preview(p, spec);
      if (!pre.ok) return fail("Preview failed; nothing was saved.", { errors: pre.errors, warnings: pre.warnings });
      const pos = svc.positionFor(spec, await svc.occupied(p, dash.id), position);
      const created = await svc.api.createChart(p.id, {
        name: spec.name,
        chartType: spec.chartType,
        description: spec.description ?? null,
        dashboardId: dash.id,
        query: pre.compiled.flow,
        queryConfig: pre.compiled.queryConfig,
        position: pos,
      });
      return ok({ created: created.id, dashboard: dash.name, position: pos, warnings: pre.warnings });
    }),
  );

  server.registerTool(
    "update_chart",
    {
      title: "Update chart",
      description:
        "Updates a chart. Pass a full spec (from get_chart, edited) to change its query/visuals; it is previewed first. Or pass only name/description/position/dashboard. Fails instead of overwriting if the chart changed since it was read.",
      inputSchema: {
        project: projectArg,
        chartId: z.string(),
        spec: ChartSpec.optional(),
        name: z.string().optional(),
        description: z.string().nullable().optional(),
        dashboard: z.string().optional().describe("Move to another dashboard (id, exact name, or \"default\")"),
        position: Position.optional(),
        size: Size.optional().describe("Resize in place"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    guard("update_chart", async ({ project, chartId, spec, name, description, dashboard, position, size }) => {
      const p = await svc.project(project);
      const current = await svc.api.getChart(p.id, chartId);
      const body: Parameters<typeof svc.api.updateChart>[2] = { expectedUpdatedAt: current.updatedAt ?? null };
      let warnings: string[] = [];

      if (spec) {
        const pre = await svc.preview(p, spec);
        if (!pre.ok) return fail("Preview failed; nothing was changed.", { errors: pre.errors, warnings: pre.warnings });
        warnings = pre.warnings;
        Object.assign(body, {
          name: spec.name,
          chartType: spec.chartType,
          description: spec.description ?? null,
          query: pre.compiled.flow,
          queryConfig: pre.compiled.queryConfig,
        });
      }
      if (name !== undefined) body.name = name;
      if (description !== undefined) body.description = description;

      let targetDash = current.dashboardId;
      if (dashboard) {
        targetDash = (await svc.resolveDashboard(p, dashboard)).id;
        body.dashboardId = targetDash;
      }
      if (position) body.position = position;
      else if (size || targetDash !== current.dashboardId || (spec?.size && (spec.size.w !== current.position?.w || spec.size.h !== current.position?.h))) {
        const want = size ?? spec?.size;
        const cur = current.position;
        const occupied = await svc.occupied(p, targetDash, chartId);
        if (targetDash === current.dashboardId && cur?.x != null && cur?.y != null && want) {
          // Resize in place when it still fits, otherwise move to the first free slot.
          const inPlace = { x: Math.min(cur.x, 12 - want.w), y: cur.y, ...want };
          const clash = occupied.some((r) => r.x < inPlace.x + inPlace.w && inPlace.x < r.x + r.w && r.y < inPlace.y + inPlace.h && inPlace.y < r.y + r.h);
          body.position = clash ? svc.positionFor({ chartType: current.chartType as never, size: want }, occupied) : inPlace;
        } else {
          body.position = svc.positionFor({ chartType: (spec?.chartType ?? current.chartType) as never, size: want }, occupied);
        }
      }

      await svc.api.updateChart(p.id, chartId, body);
      return ok({ updated: chartId, changed: Object.keys(body).filter((k) => k !== "expectedUpdatedAt"), position: body.position, warnings });
    }),
  );

  server.registerTool(
    "delete_chart",
    {
      title: "Delete chart",
      description: "Permanently deletes a chart. Requires confirm: true. Ask the user before calling this.",
      inputSchema: { project: projectArg, chartId: z.string(), confirm: z.literal(true) },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    guard("delete_chart", async ({ project, chartId }) => {
      const p = await svc.project(project);
      const chart = await svc.api.getChart(p.id, chartId);
      await svc.api.deleteChart(p.id, chartId);
      return ok({ deleted: chartId, name: chart.name });
    }),
  );

  server.registerTool(
    "create_dashboard",
    {
      title: "Create dashboard",
      description:
        "Creates a dashboard, optionally filled with charts. Every chart is previewed first; if any fails, nothing is created. Charts are laid out top-to-bottom in the given order.",
      inputSchema: {
        project: projectArg,
        name: z.string().min(1),
        description: z.string().optional(),
        isPublic: z.boolean().optional(),
        charts: z.array(ChartSpec).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    guard("create_dashboard", async ({ project, name, description, isPublic, charts = [] }) => {
      const p = await svc.project(project);
      const catalog = await svc.catalog(p);
      const previews = await Promise.all(charts.map((c) => svc.preview(p, c, catalog)));
      const failed = previews.map((r, i) => ({ chart: charts[i]!.name, errors: r.errors })).filter((x) => x.errors.length);
      if (failed.length) return fail("Some charts failed preview; nothing was created.", { failed });

      const dash = await svc.api.createDashboard(p.id, { name, description, isPublic });
      const occupied: Parameters<typeof svc.positionFor>[1] = [];
      const created: Array<{ id: string; name: string; position: unknown }> = [];
      const errors: Array<{ chart: string; error: string }> = [];
      for (const [i, spec] of charts.entries()) {
        const pos = svc.positionFor(spec, occupied);
        try {
          const c = await svc.api.createChart(p.id, {
            name: spec.name,
            chartType: spec.chartType,
            description: spec.description ?? null,
            dashboardId: dash.id,
            query: previews[i]!.compiled.flow,
            queryConfig: previews[i]!.compiled.queryConfig,
            position: pos,
          });
          created.push({ id: c.id, name: spec.name, position: pos });
        } catch (err) {
          errors.push({ chart: spec.name, error: (err as Error).message });
        }
      }
      const warnings = previews.flatMap((r, i) => r.warnings.map((w) => `${charts[i]!.name}: ${w}`));
      return ok({ dashboard: { id: dash.id, name: dash.name }, created, ...(errors.length ? { errors } : {}), warnings });
    }),
  );

  server.registerTool(
    "create_event_marker",
    {
      title: "Create event marker",
      description:
        "Adds a marker (e.g. a plugin release) that charts can overlay. Use collectionId, or collectionName to reuse/create a collection by name.",
      inputSchema: {
        project: projectArg,
        collectionId: z.string().optional(),
        collectionName: z.string().optional(),
        ...MarkerFields,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    guard("create_event_marker", async ({ project, collectionId, collectionName, ...marker }) => {
      const p = await svc.project(project);
      const collection = await svc.resolveMarkerCollection(p, { collectionId, collectionName }, true);
      const created = await svc.api.createMarker(p.id, collection.id, marker);
      return ok({ created: created.id, collectionId: collection.id });
    }),
  );

  server.registerTool(
    "bulk_create_event_markers",
    {
      title: "Bulk create event markers",
      description:
        "Adds up to 500 markers to one collection in a single call, e.g. every past release. Give each an externalId (like the version) so re-running updates them instead of adding duplicates.",
      inputSchema: {
        project: projectArg,
        collectionId: z.string().optional(),
        collectionName: z.string().optional().describe("Reused if it exists, otherwise created"),
        events: z.array(z.object(MarkerFields)).min(1).max(500),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    guard("bulk_create_event_markers", async ({ project, collectionId, collectionName, events }) => {
      const p = await svc.project(project);
      const collection = await svc.resolveMarkerCollection(p, { collectionId, collectionName }, true);
      const created = await svc.api.bulkCreateMarkers(p.id, collection.id, events);
      return ok({ collectionId: collection.id, count: created.length, markers: created.map((m) => ({ id: m.id, title: m.title, timestamp: m.timestamp })) });
    }),
  );

  server.registerTool(
    "update_event_marker",
    {
      title: "Update event marker",
      description: "Changes one marker's time, title, description, icon, emoji or color. Get eventId from list_event_markers.",
      inputSchema: {
        project: projectArg,
        collectionId: z.string().optional(),
        collectionName: z.string().optional(),
        eventId: z.string(),
        ...partialShape(MarkerFields),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    guard("update_event_marker", async ({ project, collectionId, collectionName, eventId, ...changes }) => {
      const p = await svc.project(project);
      const collection = await svc.resolveMarkerCollection(p, { collectionId, collectionName });
      const body = defined(changes);
      if (!Object.keys(body).length) throw new UserError("Nothing to change.");
      return ok({ updated: await svc.api.updateMarker(p.id, collection.id, eventId, body) });
    }),
  );

  server.registerTool(
    "delete_event_marker",
    {
      title: "Delete event marker",
      description: "Permanently deletes one marker. Requires confirm: true. Ask the user before calling this.",
      inputSchema: {
        project: projectArg,
        collectionId: z.string().optional(),
        collectionName: z.string().optional(),
        eventId: z.string(),
        confirm: z.literal(true),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    guard("delete_event_marker", async ({ project, collectionId, collectionName, eventId }) => {
      const p = await svc.project(project);
      const collection = await svc.resolveMarkerCollection(p, { collectionId, collectionName });
      await svc.api.deleteMarker(p.id, collection.id, eventId);
      return ok({ deleted: eventId, collectionId: collection.id });
    }),
  );

  server.registerTool(
    "update_marker_collection",
    {
      title: "Update marker collection",
      description: "Renames a marker collection or changes its default icon/emoji/color, grouping or visibility.",
      inputSchema: {
        project: projectArg,
        collectionId: z.string().optional(),
        collectionName: z.string().optional().describe("Current name, to find the collection"),
        name: z.string().min(1).optional().describe("New name"),
        description: z.string().nullable().optional(),
        defaultIcon: z.string().nullable().optional(),
        defaultEmoji: z.string().nullable().optional(),
        defaultColor: z.string().nullable().optional(),
        grouping: z.enum(MARKER_GROUPINGS).optional().describe("How close markers are merged on charts"),
        visibility: z.enum(MARKER_VISIBILITIES).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    guard("update_marker_collection", async ({ project, collectionId, collectionName, ...changes }) => {
      const p = await svc.project(project);
      const collection = await svc.resolveMarkerCollection(p, { collectionId, collectionName });
      const body = defined(changes);
      if (!Object.keys(body).length) throw new UserError("Nothing to change.");
      return ok({ updated: await svc.api.updateMarkerCollection(p.id, collection.id, body) });
    }),
  );

  server.registerTool(
    "delete_marker_collection",
    {
      title: "Delete marker collection",
      description:
        "Permanently deletes a marker collection and every marker in it. Requires confirm: true. Ask the user first, saying how many markers it holds.",
      inputSchema: {
        project: projectArg,
        collectionId: z.string().optional(),
        collectionName: z.string().optional(),
        confirm: z.literal(true),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    guard("delete_marker_collection", async ({ project, collectionId, collectionName }) => {
      const p = await svc.project(project);
      const collection = await svc.resolveMarkerCollection(p, { collectionId, collectionName });
      const charts = (await svc.api.listCharts(p.id))
        .filter((c) => JSON.stringify(c.queryConfig ?? null).includes(`"collectionId":${JSON.stringify(collection.id)}`))
        .map((c) => ({ id: c.id, name: c.name }));
      await svc.api.deleteMarkerCollection(p.id, collection.id);
      return ok({ deleted: collection.id, name: collection.name, ...(charts.length ? { chartsThatOverlaidIt: charts } : {}) });
    }),
  );

  // ---------------- dashboards ----------------

  server.registerTool(
    "update_dashboard",
    {
      title: "Update dashboard",
      description: "Renames a dashboard, changes its description, or makes it public/private. The default dashboard can't be changed.",
      inputSchema: {
        project: projectArg,
        dashboard: z.string().describe("Dashboard id or exact name"),
        name: z.string().min(1).optional(),
        description: z.string().nullable().optional(),
        isPublic: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    guard("update_dashboard", async ({ project, dashboard, ...changes }) => {
      const p = await svc.project(project);
      const dash = await svc.resolveStoredDashboard(p, dashboard);
      const body = defined(changes);
      if (!Object.keys(body).length) throw new UserError("Nothing to change.");
      const updated = await svc.api.updateDashboard(p.id, dash.id, body);
      return ok({ updated: { id: updated.id, name: updated.name, description: updated.description ?? null, isPublic: updated.isPublic } });
    }),
  );

  server.registerTool(
    "delete_dashboard",
    {
      title: "Delete dashboard",
      description:
        "Permanently deletes a dashboard. Requires confirm: true. Ask the user first, naming the charts on it (see get_project_context). The default dashboard can't be deleted.",
      inputSchema: { project: projectArg, dashboard: z.string().describe("Dashboard id or exact name"), confirm: z.literal(true) },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    guard("delete_dashboard", async ({ project, dashboard }) => {
      const p = await svc.project(project);
      const dash = await svc.resolveStoredDashboard(p, dashboard);
      const charts = (await svc.api.listCharts(p.id, { dashboardId: dash.id })).filter((c) => c.dashboardId === dash.id);
      await svc.api.deleteDashboard(p.id, dash.id);
      return ok({ deleted: dash.id, name: dash.name, chartsOnIt: charts.map((c) => c.name) });
    }),
  );

  server.registerTool(
    "duplicate_dashboard",
    {
      title: "Duplicate dashboard",
      description:
        "Copies a dashboard and its charts, in the same project or into targetProject. Handy as a backup before a redesign, or to reuse a layout across plugins.",
      inputSchema: {
        project: projectArg,
        dashboard: z.string().describe("Dashboard id, exact name, or \"default\""),
        targetProject: z.string().optional().describe("Slug or id of another project to copy into"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    guard("duplicate_dashboard", async ({ project, dashboard, targetProject }) => {
      const p = await svc.project(project);
      const dash = await svc.resolveDashboard(p, dashboard);
      const target = targetProject ? await svc.project(targetProject) : undefined;
      const copy = target && target.id !== p.id
        ? await svc.api.copyDashboard(p.id, dash.id, target.id)
        : await svc.api.duplicateDashboard(p.id, dash.id);
      return ok({
        created: { id: copy.id, name: copy.name, project: target?.slug ?? p.slug },
        ...(target && target.id !== p.id ? { note: "Charts that use custom metrics need the same data sources in the target project." } : {}),
      });
    }),
  );

  server.registerTool(
    "reorder_dashboards",
    {
      title: "Reorder dashboards",
      description:
        "Sets the order of dashboards in the sidebar. List dashboards (ids or exact names) in the wanted order; unlisted ones keep their relative order after them. The default dashboard stays where it is.",
      inputSchema: { project: projectArg, order: z.array(z.string()).min(1) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    guard("reorder_dashboards", async ({ project, order }) => {
      const p = await svc.project(project);
      const all = await svc.api.listDashboards(p.id);
      const movable = all.filter((d) => !d.isDefault).sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
      const picked: Dashboard[] = [];
      for (const ref of order) {
        const d = await svc.resolveStoredDashboard(p, ref, all);
        if (picked.includes(d)) throw new UserError(`"${ref}" is listed twice.`);
        picked.push(d);
      }
      const next = [...picked, ...movable.filter((d) => !picked.includes(d))];
      // Reuse the slots the movable dashboards already occupy, so the default dashboard keeps its place.
      let slots = movable.map((d) => d.position ?? 0).sort((a, b) => a - b);
      if (new Set(slots).size !== slots.length) {
        const base = Math.max(-1, ...all.filter((d) => d.isDefault).map((d) => d.position ?? 0)) + 1;
        slots = movable.map((_, i) => base + i);
      }
      await svc.api.reorderDashboards(p.id, next.map((d, i) => ({ id: d.id, position: slots[i]! })));
      return ok({ order: next.map((d) => d.name) });
    }),
  );

  // ---------------- downloads ----------------

  server.registerTool(
    "link_download_provider",
    {
      title: "Link download provider",
      description:
        "Starts tracking downloads from a platform listing (Modrinth, Spigot, Hangar, Ore, CurseForge, GitHub). Find externalId with search_download_providers.",
      inputSchema: { project: projectArg, provider: z.enum(DOWNLOAD_PROVIDERS), externalId: z.string().min(1) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    guard("link_download_provider", async ({ project, provider, externalId }) => {
      const p = await svc.project(project);
      const existing = (await svc.api.listDownloadProviders(p.id)).find((d) => d.provider === provider && d.externalId === externalId);
      if (existing) return ok({ alreadyLinked: existing });
      return ok({ linked: await svc.api.createDownloadProvider(p.id, { provider, externalId }) });
    }),
  );

  server.registerTool(
    "unlink_download_provider",
    {
      title: "Unlink download provider",
      description: "Stops tracking a linked platform listing. Requires confirm: true. Ask the user before calling this.",
      inputSchema: {
        project: projectArg,
        providerId: z.string().describe("Link id, or the listing's externalId or slug (from get_download_analytics)"),
        confirm: z.literal(true),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    guard("unlink_download_provider", async ({ project, providerId }) => {
      const p = await svc.project(project);
      const linked = await svc.api.listDownloadProviders(p.id);
      const matches = linked.filter((d) => d.id === providerId || d.externalId === providerId || d.slug === providerId);
      if (matches.length !== 1) {
        throw new UserError(
          `${matches.length ? "Several" : "No"} linked listings match "${providerId}". Linked: ${linked.map((d) => `${d.provider}:${d.slug ?? d.externalId} (${d.id})`).join(", ") || "none"}.`,
        );
      }
      await svc.api.deleteDownloadProvider(p.id, matches[0]!.id);
      return ok({ unlinked: matches[0]!.id, provider: matches[0]!.provider, title: matches[0]!.title });
    }),
  );

  server.registerTool(
    "create_data_source",
    {
      title: "Create data source",
      description:
        "Registers a custom metric so FastStats accepts and charts it. referenceId must match the key the plugin/site sends. Validation options (regex, min/max, allowNegative, allowFloat) apply to incoming values.",
      inputSchema: {
        project: projectArg,
        ...DataSourceFields,
        name: z.string().min(1),
        referenceId: z.string().min(1).describe("Metric key as sent by the client, e.g. config_death_causes"),
        dataType: z.enum(DATA_SOURCE_TYPES),
        metricShape: z.enum(METRIC_SHAPES).optional().describe("Defaults to scalar"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    guard("create_data_source", async ({ project, metricShape = "scalar", ...body }) => {
      const p = await svc.project(project);
      const existing = await svc.api.listDataSources(p.id);
      if (existing.some((s) => s.referenceId === body.referenceId)) {
        throw new UserError(`A data source with referenceId "${body.referenceId}" already exists. Use update_data_source to change it.`);
      }
      return ok({ created: await svc.api.createDataSource(p.id, { ...body, metricShape }) });
    }),
  );

  server.registerTool(
    "update_data_source",
    {
      title: "Update data source",
      description:
        "Changes a custom metric's name, description, type, shape or validation. Changing referenceId breaks charts that use the old one, so that needs force: true when charts reference it.",
      inputSchema: {
        project: projectArg,
        dataSource: z.string().describe("Data source id or referenceId"),
        ...DataSourceFields,
        name: z.string().min(1).optional(),
        referenceId: z.string().min(1).optional().describe("New referenceId"),
        dataType: z.enum(DATA_SOURCE_TYPES).optional(),
        metricShape: z.enum(METRIC_SHAPES).optional(),
        force: z.boolean().optional().describe("Rename the referenceId even if charts use it"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    guard("update_data_source", async ({ project, dataSource, force, metricShape, ...changes }) => {
      const p = await svc.project(project);
      const current = await svc.resolveDataSource(p, dataSource);
      const warnings: string[] = [];
      if (changes.referenceId !== undefined && changes.referenceId !== current.referenceId) {
        const using = await svc.chartsUsing(p, current.referenceId);
        if (using.length && !force) {
          return fail(`Charts still use "${current.referenceId}"; renaming it would break them. Nothing was changed. Pass force: true to rename anyway.`, { charts: using });
        }
        if (using.length) warnings.push(`These charts still reference "${current.referenceId}" and will need updating: ${using.map((c) => c.name).join(", ")}`);
      }
      if (changes.dataType && changes.dataType !== current.dataType) warnings.push("Changing dataType may change how existing charts filter or aggregate this metric.");
      const body = defined(changes);
      const shape = metricShape ?? (current.metricShape as (typeof METRIC_SHAPES)[number] | null | undefined) ?? (current.isArray ? "array" : "scalar");
      const updated = await svc.api.updateDataSource(p.id, current.id, { ...body, metricShape: shape });
      return ok({ updated, warnings });
    }),
  );

  server.registerTool(
    "delete_data_source",
    {
      title: "Delete data source",
      description:
        "Permanently deletes a custom metric. Requires confirm: true; ask the user first. Refuses while charts use it unless force: true.",
      inputSchema: {
        project: projectArg,
        dataSource: z.string().describe("Data source id or referenceId"),
        confirm: z.literal(true),
        force: z.boolean().optional().describe("Delete even if charts use it"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    guard("delete_data_source", async ({ project, dataSource, force }) => {
      const p = await svc.project(project);
      const ds = await svc.resolveDataSource(p, dataSource);
      const using = await svc.chartsUsing(p, ds.referenceId);
      if (using.length && !force) {
        return fail(`Charts still use "${ds.referenceId}"; nothing was deleted. Pass force: true to delete anyway.`, { charts: using });
      }
      await svc.api.deleteDataSource(p.id, ds.id);
      return ok({ deleted: ds.id, referenceId: ds.referenceId, ...(using.length ? { brokenCharts: using } : {}) });
    }),
  );
}
