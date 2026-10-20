import type { Chart, Flow, FlowNode } from "../api/types";
import { stepToNode } from "./compile";
import { type ChartSpec, type Display, formatDuration, type Output, type Step } from "./spec";

const DISPLAY_KEYS = ["iconSetId", "color", "colors", "splitPattern", "splitDataSource", "splitByCustomPattern"] as const;

export interface DecompileResult {
  outputs: Output[];
  warnings: string[];
}

/**
 * Turns a stored flow back into the series-spec format. Every step is
 * re-compiled and compared with the original node data; anything that would
 * not round-trip exactly is emitted as a raw { node, data } step, so
 * get_chart → update_chart never loses information.
 */
export function decompileFlow(flow: Flow): DecompileResult {
  const warnings: string[] = [];
  const byId = new Map(flow.nodes.map((n) => [n.id, n]));
  const incoming = new Map<string, string[]>();
  for (const e of flow.edges) {
    const list = incoming.get(e.target) ?? [];
    list.push(e.source);
    incoming.set(e.target, list);
  }

  const chainTo = (tailId: string): Step[] => {
    const chain: FlowNode[] = [];
    const seen = new Set<string>();
    for (let cur: string | undefined = tailId; cur; ) {
      if (seen.has(cur)) {
        warnings.push(`cycle detected at node ${cur}`);
        break;
      }
      seen.add(cur);
      const node = byId.get(cur);
      if (!node) {
        warnings.push(`edge points to missing node ${cur}`);
        break;
      }
      chain.unshift(node);
      const ins: string[] = incoming.get(cur) ?? [];
      if (ins.length > 1) warnings.push(`node ${cur} has ${ins.length} inputs; only the first was followed`);
      cur = ins[0];
    }
    return chain.map(nodeToStep);
  };

  const outputs: Output[] = [];
  for (const r of flow.nodes.filter((n) => normType(n) === "result")) {
    const data = r.data ?? {};
    const name = typeof data.outputName === "string" && data.outputName ? data.outputName : r.id;
    const display = toDisplay(data, warnings, r.id);
    const pred = incoming.get(r.id)?.[0];
    const predNode = pred ? byId.get(pred) : undefined;
    if (!predNode) {
      warnings.push(`result ${r.id} has no input`);
      continue;
    }
    if (normType(predNode) === "formula") {
      const fd = predNode.data ?? {};
      outputs.push(clean({
        name,
        formula: String(fd.formula ?? ""),
        precision: typeof fd.precision === "number" ? fd.precision : undefined,
        inputs: (incoming.get(predNode.id) ?? []).map((src) => ({ steps: chainTo(src) })),
        display,
      }) as Output);
    } else {
      outputs.push(clean({ name, steps: chainTo(predNode.id), display }) as Output);
    }
  }
  return { outputs, warnings };
}

export function decompileChart(chart: Chart): { spec: Omit<ChartSpec, "chartType"> & { chartType: string }; warnings: string[] } {
  const { outputs, warnings } = decompileFlow(chart.query);
  const qc = (chart.queryConfig ?? {}) as Record<string, unknown>;
  const spec = clean({
    name: chart.name,
    chartType: chart.chartType,
    description: chart.description ?? undefined,
    outputs,
    visual: (qc.visualOptions as ChartSpec["visual"]) ?? undefined,
    groupLimit: typeof qc.groupLimit === "number" ? qc.groupLimit : undefined,
    markerCollections: (qc.markerCollections as ChartSpec["markerCollections"]) ?? undefined,
    size: chart.position?.w && chart.position?.h ? { w: chart.position.w, h: chart.position.h } : undefined,
  });
  return { spec: spec as never, warnings };
}

function normType(n: FlowNode) {
  return n.type ?? n.id.replace(/-\d+(-\d+)*$/, "");
}

function nodeToStep(n: FlowNode): Step {
  const type = normType(n);
  const d = n.data ?? {};
  const candidate = guessStep(type, d);
  if (candidate) {
    const back = stepToNode(candidate);
    if (back.type === type && deepEqual(back.data, d)) return candidate;
  }
  return { node: type, data: d };
}

function guessStep(type: string, d: Record<string, unknown>): Step | undefined {
  const s = (v: unknown) => (typeof v === "string" ? v : undefined);
  switch (type) {
    case "datasource":
      return clean({
        datasource: s(d.datasource) ?? "",
        dedupe: d.dedupe === true ? undefined : (d.dedupe as boolean | undefined) ?? false,
        dedupeIdentity: d.dedupeIdentity as never,
        dataType: d.dataTypeOverride as never,
      });
    case "filter":
      return {
        filter: clean({
          field: s(d.field) ?? "",
          op: d.operator as never,
          value: d.value as string,
          dataType: d.dataType as never,
          mapTarget: d.mapFilterTarget as never,
        }),
      };
    case "aggregate":
      return { aggregate: d.function as never };
    case "groupBy":
      return Array.isArray(d.fields) ? clean({ groupBy: d.fields as string[], mode: d.mode as never }) : { groupBy: s(d.field) ?? "" };
    case "timeGroup":
      return clean({ timeGroup: d.interval as never, gapFill: d.gapFill as never, cumulative: d.cumulative as never });
    case "maxAge":
      return { maxAge: formatDuration(d.value, d.unit) };
    case "minAge":
      return { minAge: formatDuration(d.value, d.unit) };
    case "limit":
      return clean({ limit: d.limit as number, groupOthers: d.groupOthers as never });
    case "sort":
      return { sort: d.by as never, direction: d.direction as never };
    case "gapFill":
      return { gapFill: d.mode as never };
    case "dedupe":
      return { dedupe: d.identity as never };
    case "textTransform":
      return clean({ transform: d.transform as never, pattern: s(d.pattern), replacement: s(d.replacement) });
    default:
      return undefined;
  }
}

function toDisplay(data: Record<string, unknown>, warnings: string[], id: string): Display | undefined {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (k === "outputName" || v === null || v === undefined) continue;
    if ((DISPLAY_KEYS as readonly string[]).includes(k)) out[k] = v;
    else warnings.push(`result ${id}: unsupported display key "${k}" dropped`);
  }
  return Object.keys(out).length ? (out as Display) : undefined;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === (b as unknown[]).length && a.every((x, i) => deepEqual(x, (b as unknown[])[i]));
  const ka = Object.keys(a as object).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
  const kb = Object.keys(b as object).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  return ka.length === kb.length && ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

function clean<T extends Record<string, unknown>>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}
