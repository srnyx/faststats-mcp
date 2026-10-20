import type { Flow, FlowEdge, FlowNode, QueryConfig } from "../api/types";
import type { FieldCatalog } from "./fields";
import { type ChartSpec, type Display, isFormula, parseDuration, type Step } from "./spec";

export interface CompileResult {
  flow: Flow;
  queryConfig: QueryConfig;
  /** Number of result nodes: the preview must return exactly this many outputs. */
  outputCount: number;
  errors: string[];
  warnings: string[];
}

const COL_W = 260;
const ROW_H = 150;
const TIME_CHARTS = new Set(["line", "area", "bar", "heatmap", "scatter"]);

export function stepToNode(step: Step): { type: string; data: Record<string, unknown> } {
  if ("datasource" in step) {
    return {
      type: "datasource",
      data: clean({
        datasource: step.datasource,
        dedupe: step.dedupe ?? true,
        dedupeIdentity: step.dedupeIdentity,
        dataTypeOverride: step.dataType,
      }),
    };
  }
  if ("filter" in step) {
    const f = step.filter;
    return {
      type: "filter",
      data: clean({
        field: f.field,
        operator: f.op,
        value: String(f.value),
        dataType: f.dataType ?? (typeof f.value === "number" ? "number" : typeof f.value === "boolean" ? "boolean" : undefined),
        mapFilterTarget: f.mapTarget,
      }),
    };
  }
  if ("aggregate" in step) return { type: "aggregate", data: { function: step.aggregate } };
  if ("groupBy" in step) {
    const fields = Array.isArray(step.groupBy) ? step.groupBy : [step.groupBy];
    return {
      type: "groupBy",
      data: fields.length === 1 && !step.mode ? { field: fields[0] } : clean({ fields, mode: step.mode ?? "combined" }),
    };
  }
  if ("timeGroup" in step) {
    return { type: "timeGroup", data: clean({ interval: step.timeGroup, gapFill: step.gapFill ?? "zero", cumulative: step.cumulative }) };
  }
  if ("maxAge" in step) return { type: "maxAge", data: parseDuration(step.maxAge) };
  if ("minAge" in step) return { type: "minAge", data: parseDuration(step.minAge) };
  if ("limit" in step) return { type: "limit", data: clean({ limit: step.limit, groupOthers: step.groupOthers }) };
  if ("sort" in step) return { type: "sort", data: { by: step.sort, direction: step.direction ?? "desc" } };
  if ("gapFill" in step) return { type: "gapFill", data: { mode: step.gapFill } };
  if ("dedupe" in step) return { type: "dedupe", data: { identity: step.dedupe } };
  if ("transform" in step) {
    return { type: "textTransform", data: clean({ transform: step.transform, pattern: step.pattern, replacement: step.replacement }) };
  }
  return { type: step.node, data: step.data };
}

/** Field ids referenced by a step, for validation. */
function referencedFields(step: Step): string[] {
  if ("datasource" in step) return [step.datasource];
  if ("filter" in step) return [step.filter.field];
  if ("groupBy" in step) return Array.isArray(step.groupBy) ? step.groupBy : [step.groupBy];
  return [];
}

export function compile(spec: ChartSpec, catalog?: FieldCatalog): CompileResult {
  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  let row = 0;

  const addEdge = (source: string, target: string) => edges.push({ id: `edge-${source}-${target}`, source, target });

  /** Emits a linear chain, returns the id of its last node. */
  const emitChain = (steps: Step[], idSuffix: string, where: string): string => {
    validateChain(steps, where, spec.chartType, catalog, errors, warnings);
    let prev: string | undefined;
    steps.forEach((step, j) => {
      const { type, data } = stepToNode(step);
      const id = `${type}-${idSuffix}-${j}`;
      nodes.push({ id, type, data, position: { x: j * COL_W, y: row * ROW_H } });
      if (prev) addEdge(prev, id);
      prev = id;
    });
    row++;
    return prev!;
  };

  spec.outputs.forEach((out, i) => {
    const where = `outputs[${i}] "${out.name}"`;
    if (isFormula(out)) {
      validateFormula(out.formula, out.inputs.length, where, errors);
      const tails = out.inputs.map((inp, k) => emitChain(inp.steps, `${i}-${k}`, `${where} input ${letter(k)}`));
      const fid = `formula-${i}`;
      const maxLen = Math.max(...out.inputs.map((x) => x.steps.length));
      nodes.push({
        id: fid,
        type: "formula",
        data: clean({ formula: out.formula, outputName: out.name, precision: out.precision }),
        position: { x: maxLen * COL_W, y: (row - out.inputs.length) * ROW_H },
      });
      // Edge order defines the variable names (A, B, C…), so keep input order.
      for (const t of tails) addEdge(t, fid);
      const rid = `result-${i}`;
      nodes.push({ id: rid, type: "result", data: resultData(out.name, out.display), position: { x: (maxLen + 1) * COL_W, y: (row - out.inputs.length) * ROW_H } });
      addEdge(fid, rid);
    } else {
      const tail = emitChain(out.steps, String(i), where);
      const rid = `result-${i}-${out.steps.length}`;
      nodes.push({ id: rid, type: "result", data: resultData(out.name, out.display), position: { x: out.steps.length * COL_W, y: (row - 1) * ROW_H } });
      addEdge(tail, rid);
      if (out.display?.splitDataSource && catalog && !catalog.has(out.display.splitDataSource)) {
        errors.push(unknownField(out.display.splitDataSource, `${where} display.splitDataSource`, catalog));
      }
    }
  });

  if (spec.chartType === "widget" && spec.outputs.length > 1) {
    warnings.push("widget charts display a single value; only the first output will show.");
  }

  const queryConfig: QueryConfig = clean({
    groupLimit: spec.groupLimit,
    visualOptions: spec.visual ?? null,
    markerCollections: spec.markerCollections,
  });

  return { flow: { type: "flow", nodes, edges }, queryConfig, outputCount: spec.outputs.length, errors, warnings };
}

function validateChain(
  steps: Step[],
  where: string,
  chartType: string,
  catalog: FieldCatalog | undefined,
  errors: string[],
  warnings: string[],
) {
  if (!steps[0] || !("datasource" in steps[0])) errors.push(`${where}: the first step must be { "datasource": ... }.`);
  steps.slice(1).forEach((s, j) => {
    if ("datasource" in s) errors.push(`${where} step ${j + 1}: only the first step may be a datasource.`);
  });

  if (catalog) {
    for (const s of steps) {
      for (const f of referencedFields(s)) if (!catalog.has(f)) errors.push(unknownField(f, where, catalog));
      if ("filter" in s) {
        const info = catalog.get(s.filter.field);
        if (info?.shape === "map" && !s.filter.mapTarget) {
          warnings.push(`${where}: "${s.filter.field}" is a map metric; set filter.mapTarget to "key" or "value".`);
        }
      }
    }
  }

  const idx = (pred: (s: Step) => boolean) => steps.findIndex(pred);
  const agg = idx((s) => "aggregate" in s);
  const grp = idx((s) => "groupBy" in s);
  const tg = idx((s) => "timeGroup" in s);
  if (agg === -1 && !steps.some((s) => "node" in s)) {
    warnings.push(`${where}: no aggregate step. Every built-in chart aggregates (usually "count" for servers, "sum" for players).`);
  }
  if (agg !== -1 && grp > agg) warnings.push(`${where}: groupBy comes after aggregate; built-in charts group first.`);
  if (agg !== -1 && tg > agg) warnings.push(`${where}: timeGroup comes after aggregate; built-in charts bucket time first.`);
  if (tg !== -1 && !TIME_CHARTS.has(chartType)) warnings.push(`${where}: timeGroup has no effect on a ${chartType} chart.`);
  if (tg === -1 && (chartType === "line" || chartType === "area")) {
    warnings.push(`${where}: ${chartType} charts usually need a timeGroup step (e.g. { "timeGroup": "hour" }).`);
  }
  if (chartType === "map" && !steps.some((s) => "groupBy" in s && [s.groupBy].flat().includes("internal:country"))) {
    warnings.push(`${where}: map charts expect { "groupBy": "internal:country" }.`);
  }
}

function validateFormula(formula: string, inputCount: number, where: string, errors: string[]) {
  const allowed = new Set(Array.from({ length: inputCount }, (_, k) => letter(k)));
  const idents = formula.match(/[A-Za-z_]\w*/g) ?? [];
  const bad = [...new Set(idents.filter((v) => !allowed.has(v.toUpperCase())))];
  if (bad.length) {
    errors.push(
      `${where}: formula uses ${bad.map((b) => `"${b}"`).join(", ")} but only ${[...allowed].join(", ")} exist ` +
        `(inputs are named A, B, C… in order). FastStats silently returns nothing for unknown names.`,
    );
  }
  if (!/^[\sA-Za-z0-9_.+\-*/()]+$/.test(formula)) errors.push(`${where}: formula may only contain inputs, numbers, + - * / and parentheses.`);
}

function resultData(name: string, d?: Display): Record<string, unknown> {
  return clean({ outputName: name, ...d });
}

function unknownField(f: string, where: string, catalog: FieldCatalog) {
  const root = catalog.rootOf(f);
  if (root?.shape === "map") {
    const key = f.slice(root.id.length + 1);
    return (
      `${where}: "${root.id}" is a map metric, so dot paths like "${f}" are not supported. ` +
      `Use { "datasource": "${root.id}" }, { "filter": { "field": "${root.id}", "op": "equals", "value": "${key}", "mapTarget": "key" } }, ` +
      `then { "groupBy": "${root.id}" } with display.splitPattern "{value}".`
    );
  }
  const s = catalog.suggest(f);
  return `${where}: unknown field "${f}".${s.length ? ` Did you mean ${s.map((x) => `"${x}"`).join(", ")}?` : ""} Use get_project_context to list fields.`;
}

export const letter = (k: number) => String.fromCharCode(65 + k);

function clean<T extends Record<string, unknown>>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}
