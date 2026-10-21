import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ErrorQuery } from "../api/client";
import { ERROR_PRIORITIES, ERROR_RESOLVE_MODES, ERROR_STATUSES, type ErrorIssue, type ProjectSummary } from "../api/types";
import { type FastStatsService, trim, UserError } from "../service";
import { defined, fail, guard, ok, projectArg, RO } from "./util";

const errorIds = z.array(z.string().min(1)).min(1).max(100).describe("errorId values from list_errors");

const timeArg = (what: string) => z.string().optional().describe(`${what}: a duration back from now (30m, 24h, 7d, 2w) or an ISO timestamp`);

const filterArg = z
  .array(z.object({ field: z.string(), operator: z.enum(["equals", "not_equals"]), value: z.string() }))
  .optional()
  .describe("Field filters, e.g. { field: \"plugin_version\", operator: \"equals\", value: \"1.4.0\" }. See get_error_filter_options for fields and values.");

/** Parses "24h" / "7d" style durations (relative to now) or an ISO timestamp. */
export function parseTime(value: string, now = Date.now()): Date {
  const m = /^(\d+(?:\.\d+)?)\s*(m|min|h|d|w)$/i.exec(value.trim());
  if (m) {
    const unit = { m: 60_000, min: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[m[2]!.toLowerCase() as "m"];
    return new Date(now - Number(m[1]) * unit);
  }
  const t = Date.parse(value);
  if (Number.isNaN(t)) throw new UserError(`Can't read "${value}" as a time. Use a duration like 24h or 7d, or an ISO timestamp.`);
  return new Date(t);
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);

const stackOf = (i: { mappedLatestStack?: string[]; latestStack?: string[] }) =>
  i.mappedLatestStack?.length ? i.mappedLatestStack : (i.latestStack ?? []);

/** The fields worth reading in a list; the raw issue carries ~40 more. */
function summarize(i: ErrorIssue, slug: string | undefined, frames: number) {
  return {
    errorId: i.errorId,
    id: i.id,
    ...(slug ? { project: slug } : {}),
    name: i.errorName,
    message: clip(i.errorMessage, 300),
    status: i.status,
    regressed: i.regressed ?? false,
    viewed: i.viewed,
    priority: i.priority ?? null,
    assignee: i.assigneeName ?? null,
    labels: (i.labels ?? []).map((l) => l.name),
    occurrences: i.occurrenceCount,
    sessions: i.affectedSessionCount,
    firstSeen: i.firstOccurred,
    lastSeen: i.lastOccurred,
    firstVersion: i.firstPluginVersion ?? null,
    latestVersion: i.pluginVersion ?? null,
    stack: stackOf(i).slice(0, frames),
  };
}

export function registerErrorTools(server: McpServer, svc: FastStatsService, opts: { readOnly: boolean }) {
  server.registerTool(
    "list_errors",
    {
      title: "List errors",
      description:
        "Lists error-tracking issues for one project, several, or \"all\". For a daily digest use projects: \"all\" and newSince: \"24h\": that returns only issues first seen in that window (reason \"new\") or regressed after being resolved (reason \"regressed\").",
      inputSchema: {
        project: projectArg,
        projects: z
          .union([z.literal("all"), z.array(z.string()).min(1)])
          .optional()
          .describe("Query several projects at once (slugs or ids), or \"all\" for every project the key can access. Overrides project."),
        newSince: timeArg("Only issues that are new or regressed since then"),
        from: timeArg("Only issues that occurred after this"),
        to: timeArg("…and before this"),
        status: z.enum(ERROR_STATUSES).optional().describe("Default active"),
        search: z.string().optional().describe("Free-text search over name, message and stack"),
        filters: filterArg,
        unviewedOnly: z.boolean().optional().describe("Only issues nobody has opened yet"),
        includeTrend: z.boolean().optional().describe("Also return error counts per time bucket"),
        limit: z.number().int().min(1).max(200).optional().describe("Max issues returned (default 25)"),
        stackFrames: z.number().int().min(0).max(50).optional().describe("Top stack frames per issue (default 5)"),
      },
      annotations: RO,
    },
    guard("list_errors", async ({ project, projects, newSince, from, to, status = "active", search, filters, unviewedOnly, includeTrend, limit = 25, stackFrames = 5 }) => {
      const since = newSince ? parseTime(newSince) : undefined;
      const fromDate = since ?? (from ? parseTime(from) : undefined);
      const toDate = to ? parseTime(to) : undefined;

      let target: { project: string } | { projectIds: string[] };
      let slugs: Map<string, string> | undefined;
      if (projects) {
        const list: ProjectSummary[] =
          projects === "all" ? await svc.api.listProjects() : await Promise.all(projects.map((p) => svc.project(p)));
        if (!list.length) throw new UserError("No projects to query.");
        slugs = new Map(list.map((p) => [p.id, p.slug]));
        target = { projectIds: [...slugs.keys()] };
      } else {
        target = { project: (await svc.project(project)).id };
      }

      // When filtering locally (new/regressed, unviewed), fetch more than will be returned.
      const filtering = !!since || !!unviewedOnly;
      const query: ErrorQuery = defined({
        from: fromDate?.getTime(),
        to: toDate?.getTime(),
        status,
        searchQuery: search,
        filters,
        limit: filtering ? 500 : limit,
      });
      const [issues, trend] = await Promise.all([
        svc.api.queryErrorIssues(target, query),
        includeTrend ? svc.api.queryErrorTimeseries(target, query) : undefined,
      ]);

      let rows: Array<{ i: ErrorIssue; reason?: "new" | "regressed" }> = issues.map((i) => ({ i }));
      if (since) {
        const t = since.getTime();
        rows = rows.flatMap(({ i }): typeof rows => {
          const first = Date.parse(i.firstOccurred);
          const last = Date.parse(i.lastOccurred);
          // Unparseable dates are kept: better to over-report than to hide an error.
          if (Number.isNaN(first) || first >= t) return [{ i, reason: "new" }];
          if (i.regressed && (Number.isNaN(last) || last >= t)) return [{ i, reason: "regressed" }];
          return [];
        });
        rows.sort((a, b) => (a.reason === b.reason ? Number(b.i.occurrenceCount) - Number(a.i.occurrenceCount) : a.reason === "new" ? -1 : 1));
      }
      if (unviewedOnly) rows = rows.filter(({ i }) => i.viewed === false);

      return ok({
        window: { from: fromDate?.toISOString() ?? null, to: toDate?.toISOString() ?? null, status },
        total: rows.length,
        issues: rows.slice(0, limit).map(({ i, reason }) => ({ ...(reason ? { reason } : {}), ...summarize(i, slugs?.get(i.projectId), stackFrames) })),
        ...(rows.length > limit ? { more: rows.length - limit } : {}),
        ...(filtering && issues.length >= 500 ? { warning: "FastStats returned 500 issues, the most fetched for filtering; narrow from/to or add filters to be sure nothing is missed." } : {}),
        ...(trend ? { trend: trend.map((b) => ({ date: b.date, errors: b.errors, uniqueErrors: b.uniqueErrors })) } : {}),
      });
    }),
  );

  server.registerTool(
    "get_error",
    {
      title: "Get error",
      description:
        "One error issue in full: complete stack, resolution, labels, daily timeline, and its latest occurrences with their environment (plugin/Minecraft/Java version, server type, OS) and context.",
      inputSchema: {
        project: projectArg,
        errorId: z.string().min(1).describe("errorId from list_errors"),
        occurrences: z.number().int().min(0).max(20).optional().describe("Latest occurrences to include (default 3)"),
        variants: z.number().int().min(0).max(20).optional().describe("Distinct stack trace variants to include (default 0)"),
      },
      annotations: RO,
    },
    guard("get_error", async ({ project, errorId, occurrences = 3, variants = 0 }) => {
      const p = await svc.project(project);
      const [detail, occ, vars] = await Promise.all([
        svc.api.getErrorIssue(p.id, errorId),
        occurrences ? svc.api.listErrorOccurrences(p.id, errorId, occurrences) : [],
        variants ? svc.api.listErrorStackVariants(p.id, errorId, variants) : [],
      ]);
      const i = detail.issue;
      return ok({
        ...summarize(i, undefined, 60),
        message: i.errorMessage,
        language: i.language ?? null,
        affectedVersions: i.affectedVersions ?? [],
        resolution: i.resolution ?? null,
        comments: i.commentCount ?? 0,
        timeline: (detail.timeline ?? []).slice(-30).map((b) => ({ date: b.date, errors: b.errors })),
        occurrences: occ.map(({ latestStack, mappedStack, context, ...o }) => ({
          ...(trim(o) as object),
          stack: (mappedStack?.length ? mappedStack : (latestStack ?? [])).slice(0, 30),
          ...(context ? { context: trim(context) } : {}),
        })),
        ...(vars.length ? { variants: vars.map((v) => ({ id: v.id, occurrences: v.occurrenceCount, stack: v.stack.slice(0, 15) })) } : {}),
      });
    }),
  );

  server.registerTool(
    "get_error_filter_options",
    {
      title: "Get error filter options",
      description: "Fields and values usable in list_errors filters (plugin, Minecraft and Java versions, server types, OS, country…), plus the project's error labels.",
      inputSchema: { project: projectArg },
      annotations: RO,
    },
    guard("get_error_filter_options", async ({ project }) => {
      const p = await svc.project(project);
      const [meta, labels] = await Promise.all([svc.api.getErrorFilterMeta(p.id), svc.api.listErrorLabels(p.id)]);
      return ok({
        filters: Object.fromEntries(
          Object.entries(meta)
            .filter(([, v]) => v?.length)
            .map(([k, v]) => [k.replace(/_values$/, ""), v!.slice(0, 50)]),
        ),
        labels: labels.map((l) => ({ id: l.id, name: l.name, color: l.color, issues: l.issueCount ?? undefined })),
      });
    }),
  );

  if (opts.readOnly) return;

  const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

  server.registerTool(
    "update_error",
    {
      title: "Update error",
      description: "Sets an error's priority, assignee, or labels (by name or id; replaces the current set, [] clears it).",
      inputSchema: {
        project: projectArg,
        errorId: z.string().min(1),
        priority: z.enum(ERROR_PRIORITIES).nullable().optional(),
        assigneeId: z.string().nullable().optional().describe("User id; null unassigns"),
        labels: z.array(z.string()).optional().describe("Label names or ids, see get_error_filter_options"),
      },
      annotations: write,
    },
    guard("update_error", async ({ project, errorId, labels, ...meta }) => {
      const p = await svc.project(project);
      const body = defined(meta);
      if (!Object.keys(body).length && labels === undefined) throw new UserError("Nothing to change.");
      let labelIds: string[] | undefined;
      if (labels) {
        const all = await svc.api.listErrorLabels(p.id);
        const missing: string[] = [];
        labelIds = labels.flatMap((ref) => {
          const hit = all.find((l) => l.id === ref) ?? all.find((l) => l.name.toLowerCase() === ref.toLowerCase());
          if (!hit) missing.push(ref);
          return hit ? [hit.id] : [];
        });
        if (missing.length) throw new UserError(`Unknown labels: ${missing.join(", ")}. Existing: ${all.map((l) => l.name).join(", ") || "none"}.`);
      }
      if (Object.keys(body).length) await svc.api.updateErrorIssue(p.id, errorId, body);
      if (labelIds) await svc.api.setErrorLabels(p.id, errorId, labelIds);
      return ok({ updated: errorId, ...body, ...(labels ? { labels } : {}) });
    }),
  );

  server.registerTool(
    "resolve_errors",
    {
      title: "Resolve errors",
      description:
        "Marks errors resolved. mode: once (reopens on the next occurrence), version (reopens if seen in a newer version), version_and_prior, or forever (never reopens). Confirm the mode with the user.",
      inputSchema: {
        project: projectArg,
        errorIds,
        mode: z.enum(ERROR_RESOLVE_MODES),
        note: z.string().optional(),
      },
      annotations: write,
    },
    guard("resolve_errors", async ({ project, errorIds, mode, note }) => {
      const p = await svc.project(project);
      await svc.api.resolveErrors(p.id, errorIds, mode, note);
      return ok({ resolved: errorIds, mode });
    }),
  );

  server.registerTool(
    "reopen_errors",
    {
      title: "Reopen errors",
      description: "Clears the resolution of resolved errors so they are active again.",
      inputSchema: { project: projectArg, errorIds },
      annotations: write,
    },
    guard("reopen_errors", async ({ project, errorIds }) => {
      const p = await svc.project(project);
      await svc.api.reopenErrors(p.id, errorIds);
      return ok({ reopened: errorIds });
    }),
  );

  server.registerTool(
    "mark_errors_viewed",
    {
      title: "Mark errors viewed",
      description: "Marks errors as seen, e.g. after reporting them in a digest, so list_errors with unviewedOnly skips them next time.",
      inputSchema: { project: projectArg, errorIds },
      annotations: write,
    },
    guard("mark_errors_viewed", async ({ project, errorIds }) => {
      const p = await svc.project(project);
      await svc.api.markErrorsViewed(p.id, errorIds);
      return ok({ viewed: errorIds });
    }),
  );

  server.registerTool(
    "merge_errors",
    {
      title: "Merge errors",
      description: "Merges duplicate issues into one primary issue. Requires confirm: true. Ask the user first.",
      inputSchema: {
        project: projectArg,
        primaryErrorId: z.string().min(1),
        mergedErrorIds: errorIds.describe("Issues to fold into the primary one"),
        confirm: z.literal(true),
      },
      annotations: { ...write, destructiveHint: true, idempotentHint: false },
    },
    guard("merge_errors", async ({ project, primaryErrorId, mergedErrorIds }) => {
      const p = await svc.project(project);
      if (mergedErrorIds.includes(primaryErrorId)) return fail("primaryErrorId can't also be in mergedErrorIds.");
      const r = await svc.api.mergeErrors(p.id, primaryErrorId, mergedErrorIds);
      return ok({ primaryErrorId: r.primaryErrorId, merged: mergedErrorIds });
    }),
  );

  server.registerTool(
    "delete_errors",
    {
      title: "Delete errors",
      description: "Permanently deletes error issues and their occurrences. Requires confirm: true. Ask the user before calling this; resolving is usually what they want.",
      inputSchema: { project: projectArg, errorIds, confirm: z.literal(true) },
      annotations: { ...write, destructiveHint: true },
    },
    guard("delete_errors", async ({ project, errorIds }) => {
      const p = await svc.project(project);
      const r = await svc.api.deleteErrors(p.id, errorIds);
      return ok({ deleted: r.ids, ...(r.pending ? { note: "Deletion is processing in the background." } : {}) });
    }),
  );
}
