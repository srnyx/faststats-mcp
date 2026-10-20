import { readFileSync } from "node:fs";
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
