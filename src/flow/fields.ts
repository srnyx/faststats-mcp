import type { DataSource } from "../api/types";

export type FieldType = "string" | "number" | "boolean" | "datetime";
export type MetricShape = "scalar" | "array" | "map";

export interface FieldInfo {
  id: string;
  name: string;
  dataType: FieldType | string;
  shape: MetricShape | string;
  kind: "internal" | "custom";
  description?: string | null;
}

type Scope = "all" | "minecraft-plugin" | "web-analytics";

// From the web app's internal-fields bundle (2026-10-19). Only names and types the UI exposes.
const INTERNAL: Array<{ id: string; name: string; dataType: FieldType; scope: Scope[]; shape?: MetricShape }> = [
  { id: "internal:created_at", name: "Created At", dataType: "datetime", scope: ["all"] },
  { id: "internal:country", name: "Country", dataType: "string", scope: ["all"] },
  { id: "internal:server_count", name: "Server Count", dataType: "number", scope: ["minecraft-plugin", "web-analytics"] },

  { id: "internal:server_id", name: "Server ID", dataType: "string", scope: ["minecraft-plugin"] },
  { id: "internal:player_count", name: "Player Count", dataType: "number", scope: ["minecraft-plugin"] },
  { id: "internal:online_mode", name: "Online Mode", dataType: "boolean", scope: ["minecraft-plugin"] },
  { id: "internal:client", name: "Client", dataType: "boolean", scope: ["minecraft-plugin"] },
  { id: "internal:plugin_version", name: "Plugin Version", dataType: "string", scope: ["minecraft-plugin"] },
  { id: "internal:game_version", name: "Game Version", dataType: "string", scope: ["minecraft-plugin"] },
  { id: "internal:minecraft_version", name: "Minecraft Version", dataType: "string", scope: ["minecraft-plugin"] },
  { id: "internal:server_type", name: "Platform", dataType: "string", scope: ["minecraft-plugin"] },
  { id: "internal:platform_version", name: "Platform Version", dataType: "string", scope: ["minecraft-plugin"] },
  { id: "internal:java_version", name: "Java Version", dataType: "string", scope: ["minecraft-plugin"] },
  { id: "internal:java_vendor", name: "Java Vendor", dataType: "string", scope: ["minecraft-plugin"] },
  { id: "internal:os_name", name: "OS Name", dataType: "string", scope: ["minecraft-plugin"] },
  { id: "internal:os_version", name: "OS Version", dataType: "string", scope: ["minecraft-plugin", "web-analytics"] },
  { id: "internal:os_arch", name: "OS Architecture", dataType: "string", scope: ["minecraft-plugin"] },
  { id: "internal:core_count", name: "Core Count", dataType: "number", scope: ["minecraft-plugin"] },

  ...(
    [
      "event", "url", "user_id", "session_id", "browser", "browser_version", "device", "os", "referrer",
      "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "timezone", "language", "screen",
      "title", "page", "entry_page", "exit_page", "outbound_link",
    ] as const
  ).map((f) => ({ id: `internal:${f}`, name: f, dataType: "string" as const, scope: ["web-analytics"] as Scope[] })),
  { id: "internal:is_identified", name: "Is Identified", dataType: "boolean", scope: ["web-analytics"] },
  { id: "internal:cookieless", name: "Cookieless", dataType: "boolean", scope: ["web-analytics"] },
  { id: "internal:session_duration", name: "Session Duration", dataType: "number", scope: ["web-analytics"] },
  { id: "internal:bounce_rate", name: "Bounce Rate", dataType: "number", scope: ["web-analytics"] },
  { id: "internal:event_properties", name: "Event Properties", dataType: "string", scope: ["web-analytics"], shape: "map" },
];

export class FieldCatalog {
  private readonly byId = new Map<string, FieldInfo>();

  constructor(templateId: string | null | undefined, dataSources: DataSource[]) {
    const scope = (templateId ?? "") as Scope;
    const known = scope === "minecraft-plugin" || scope === "web-analytics";
    for (const f of INTERNAL) {
      if (known && !f.scope.includes("all") && !f.scope.includes(scope)) continue;
      this.byId.set(f.id, { id: f.id, name: f.name, dataType: f.dataType, shape: f.shape ?? "scalar", kind: "internal" });
    }
    for (const ds of dataSources) {
      this.byId.set(ds.referenceId, {
        id: ds.referenceId,
        name: ds.name,
        dataType: ds.dataType,
        shape: ds.metricShape ?? (ds.isArray ? "array" : "scalar"),
        kind: "custom",
        description: ds.description,
      });
    }
  }

  get(id: string) {
    return this.byId.get(id) ?? this.jsonPathRoot(id);
  }

  /** True for known fields and for dot paths into JSON metrics, e.g. "storage.cache.enabled". */
  has(id: string) {
    return this.byId.has(id) || this.jsonPathRoot(id) !== undefined;
  }

  /** The metric a dot path points into, when that path is something FastStats can query. */
  rootOf(id: string): FieldInfo | undefined {
    const dot = id.indexOf(".");
    return dot > 0 ? this.byId.get(id.slice(0, dot)) : undefined;
  }

  // FastStats resolves "<metric>.<key>.<key>" on JSON metrics (verified on live data, 2026-10-19).
  // On map metrics the same path is a 500 "unsupported query composition", so it is not accepted there.
  private jsonPathRoot(id: string): FieldInfo | undefined {
    const root = this.rootOf(id);
    if (!root || root.kind !== "custom" || root.dataType !== "json" || id.endsWith(".") || id.includes("..")) return undefined;
    return { ...root, id, name: `${root.name}: ${id.slice(root.id.length + 1)}`, dataType: "string", shape: "scalar" };
  }

  all() {
    return [...this.byId.values()];
  }

  /** Closest known field ids, for "did you mean" errors. */
  suggest(id: string, n = 3): string[] {
    const target = id.replace(/^internal:/, "").toLowerCase();
    return this.all()
      .map((f) => ({ id: f.id, d: distance(target, f.id.replace(/^internal:/, "").toLowerCase()) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, n)
      .filter((x) => x.d <= Math.max(3, Math.floor(target.length / 2)))
      .map((x) => x.id);
  }
}

function distance(a: string, b: string): number {
  if (a === b) return 0;
  if (b.includes(a) || a.includes(b)) return 1;
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j]!;
      dp[j] = Math.min(dp[j]! + 1, dp[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length]!;
}
