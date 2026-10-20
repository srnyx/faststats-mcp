import type { Position } from "../api/types";

export const GRID_COLUMNS = 12;

// Observed on the default Minecraft dashboard.
const DEFAULT_SIZES: Record<string, { w: number; h: number }> = {
  widget: { w: 3, h: 2 },
  line: { w: 12, h: 3 },
  area: { w: 12, h: 3 },
  bar: { w: 6, h: 4 },
  pie: { w: 4, h: 4 },
  map: { w: 8, h: 4 },
  list: { w: 4, h: 4 },
  heatmap: { w: 12, h: 4 },
  radar: { w: 4, h: 4 },
  scatter: { w: 6, h: 4 },
  treemap: { w: 6, h: 4 },
  table: { w: 6, h: 4 },
};

export function defaultSize(chartType: string): { w: number; h: number } {
  return DEFAULT_SIZES[chartType] ?? { w: 6, h: 4 };
}

export type Rect = { x: number; y: number; w: number; h: number };

/** Normalises positions read from the API (fields may be null). */
export function toRect(p: { x?: number | null; y?: number | null; w?: number | null; h?: number | null } | null | undefined): Rect | undefined {
  if (!p || p.w == null || p.h == null) return undefined;
  return { x: p.x ?? 0, y: p.y ?? 0, w: p.w, h: p.h };
}

const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * First-fit placement: scans rows top to bottom, columns left to right, and
 * returns the first slot that does not overlap any existing chart. `occupied`
 * is mutated so a batch of placements packs together.
 */
export function place(occupied: Rect[], size: { w: number; h: number }): Position {
  const w = Math.min(Math.max(1, size.w), GRID_COLUMNS);
  const h = Math.max(1, size.h);
  const maxY = occupied.reduce((m, r) => Math.max(m, r.y + r.h), 0);
  for (let y = 0; y <= maxY; y++) {
    for (let x = 0; x + w <= GRID_COLUMNS; x++) {
      const cand = { x, y, w, h };
      if (!occupied.some((r) => overlaps(r, cand))) {
        occupied.push(cand);
        return cand;
      }
    }
  }
  const cand = { x: 0, y: maxY, w, h };
  occupied.push(cand);
  return cand;
}
