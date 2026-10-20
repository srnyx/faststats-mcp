import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { FastStatsError } from "../api/client";
import { Position } from "../api/types";
import { decompileChart } from "../flow/decompile";
import { ChartSpec, Size } from "../flow/spec";
import guide from "../resources/guide.md";
import { log } from "../log";
import { type FastStatsService, UserError } from "../service";

const projectArg = z
  .string()
  .optional()
  .describe("Project slug or id. Optional when FASTSTATS_DEFAULT_PROJECT is set.");

const ok = (value: unknown): CallToolResult => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});

const fail = (message: string, extra?: Record<string, unknown>): CallToolResult => ({
  isError: true,
  content: [{ type: "text", text: JSON.stringify({ error: message, ...extra }, null, 2) }],
});

/** Converts thrown errors into tool errors Claude can act on. */
const guard =
  <A>(name: string, fn: (args: A) => Promise<CallToolResult>) =>
  async (args: A): Promise<CallToolResult> => {
    try {
      return await fn(args);
    } catch (err) {
      if (err instanceof UserError || err instanceof FastStatsError) return fail(err.message);
      log.error(`${name} crashed`, (err as Error).stack ?? String(err));
      return fail(`Unexpected error in ${name}: ${(err as Error).message}`);
    }
  };

export function registerTools(server: McpServer, svc: FastStatsService, opts: { readOnly: boolean }) {
  const RO = { readOnlyHint: true, openWorldHint: true } as const;

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
        timestamp: z.string().describe("ISO 8601 timestamp"),
        title: z.string(),
        description: z.string().optional(),
        emoji: z.string().optional(),
        color: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    guard("create_event_marker", async ({ project, collectionId, collectionName, ...marker }) => {
      const p = await svc.project(project);
      let id = collectionId;
      if (!id) {
        if (!collectionName) throw new UserError("Pass collectionId or collectionName.");
        const existing = (await svc.api.listMarkerCollections(p.id)).find((c) => c.name.toLowerCase() === collectionName.toLowerCase());
        id = existing?.id ?? (await svc.api.createMarkerCollection(p.id, { name: collectionName })).id;
      }
      const created = await svc.api.createMarker(p.id, id, marker);
      return ok({ created: created.id, collectionId: id });
    }),
  );
}
