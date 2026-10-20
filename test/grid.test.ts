import { describe, expect, it } from "vitest";
import { place } from "../src/layout/grid";
import { loadDefaultCharts } from "./helpers";

describe("grid placement", () => {
  it("packs four widgets across the top row", () => {
    const occ: Parameters<typeof place>[0] = [];
    const xs = [0, 1, 2, 3].map(() => place(occ, { w: 3, h: 2 }));
    expect(xs.map((p) => [p.x, p.y])).toEqual([[0, 0], [3, 0], [6, 0], [9, 0]]);
    expect(place(occ, { w: 12, h: 3 })).toEqual({ x: 0, y: 2, w: 12, h: 3 });
  });

  it("appends below the default dashboard", () => {
    const occ = loadDefaultCharts().map((c) => ({ x: c.position!.x!, y: c.position!.y!, w: c.position!.w!, h: c.position!.h! }));
    expect(place(occ, { w: 4, h: 4 })).toEqual({ x: 0, y: 17, w: 4, h: 4 });
  });

  it("fills holes", () => {
    const occ = [{ x: 0, y: 0, w: 4, h: 4 }, { x: 8, y: 0, w: 4, h: 4 }];
    expect(place(occ, { w: 4, h: 4 })).toEqual({ x: 4, y: 0, w: 4, h: 4 });
  });
});
