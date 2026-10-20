import { readFileSync } from "node:fs";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { FastStatsClient } from "../src/api/client";
import { FastStatsService } from "../src/service";
import { registerTools } from "../src/tools/index";
import { fileURLToPath } from "node:url";
import { Chart, type DataSource } from "../src/api/types";
import { FieldCatalog } from "../src/flow/fields";

export function loadDefaultCharts(): Chart[] {
  const raw = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/default-dashboard.json", import.meta.url)), "utf8")) as unknown[];
  return raw.map((c, i) =>
    Chart.parse({ id: `chart-${i}`, projectId: "p", dashboardId: "default:p", updatedAt: "2026-10-19T00:00:00.000Z", ...(c as object) }),
  );
}

// Custom metrics of the Limited Lives plugin (GET /data-sources, 2026-10-19).
export const LIMITED_LIVES_SOURCES: DataSource[] = [
  ["update_checker_outdated_latest_version", "string", "scalar"],
  ["annoying_api_version", "string", "scalar"],
  ["config_death_causes", "string", "array"],
  ["config_worlds_blacklist_affected_features", "string", "array"],
  ["config_grace_period_triggers", "string", "array"],
  ["config_grace_period_bypass_causes", "string", "array"],
  ["config_grace_period_disabled_damage_causes", "string", "array"],
  ["config_obtaining_crafting_triggers", "string", "array"],
  ["messages_plugin_global_placeholders_keys", "string", "array"],
  ["placeholderapi_version", "string", "scalar"],
  ["config", "string", "map"],
  ["messages", "string", "map"],
  ["storage", "string", "map"],
  ["storage_cache_save_on", "string", "array"],
].map(([referenceId, dataType, metricShape], i) => ({
  id: `ds-${i}`,
  name: referenceId!,
  referenceId: referenceId!,
  dataType: dataType!,
  metricShape,
  isArray: metricShape === "array",
}));

export const limitedLivesCatalog = () => new FieldCatalog("minecraft-plugin", LIMITED_LIVES_SOURCES);

export type ApiCall = { method: string; path: string; query: Record<string, string>; body?: unknown };
type Route = (body: unknown, query: Record<string, string>) => unknown;

/** Registers every tool against a fake FastStats API ("METHOD /path" → handler) for project p1. */
export function toolHarness(routes: Record<string, Route>) {
  const calls: ApiCall[] = [];
  const all: Record<string, Route> = {
    "GET /v0/projects/p1": () => ({ id: "p1", name: "LL", slug: "p1", templateId: "minecraft-plugin" }),
    "GET /v0/projects/p2": () => ({ id: "p2", name: "Other", slug: "p2", templateId: "minecraft-plugin" }),
    ...routes,
  };
  const fetchImpl = (async (url: URL, init: RequestInit) => {
    const call: ApiCall = {
      method: init.method!,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const route = all[`${call.method} ${call.path}`];
    if (!route) return new Response(JSON.stringify({ message: `no route for ${call.method} ${call.path}` }), { status: 404 });
    const out = route(call.body, call.query);
    return out === undefined ? new Response(null, { status: 204 }) : new Response(JSON.stringify(out), { status: 200 });
  }) as unknown as typeof fetch;

  const handlers = new Map<string, (args: unknown) => Promise<CallToolResult>>();
  const server = { registerTool: (name: string, _def: unknown, fn: (args: unknown) => Promise<CallToolResult>) => handlers.set(name, fn) };
  const svc = new FastStatsService(new FastStatsClient({ apiKey: "k", baseUrl: "https://api.example" }, fetchImpl), "p1");
  registerTools(server as never, svc, { readOnly: false });

  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await handlers.get(name)!(args);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { isError: r.isError ?? false, data: JSON.parse((r.content[0] as { text: string }).text) as Record<string, any> };
  };
  const writes = () => calls.filter((c) => c.method !== "GET");
  return { call, calls, writes };
}
