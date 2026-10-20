// Network test: run with `npm run test:contract`. Compares the enums this
// server hard-codes with the live FastStats OpenAPI spec, so API drift shows
// up as a failing test instead of a confusing tool error.
import { describe, expect, it } from "vitest";
import { CHART_TYPES, VisualOptions } from "../src/api/types";

type Schema = { anyOf?: Schema[]; enum?: string[]; properties?: Record<string, Schema>; $ref?: string };

const unwrap = (s: Schema | undefined): Schema | undefined => {
  if (!s) return s;
  if (s.anyOf) return unwrap(s.anyOf.find((x) => x.properties || x.enum) ?? s.anyOf[0]);
  return s;
};

describe("FastStats OpenAPI contract", async () => {
  const spec = (await (await fetch("https://api.faststats.dev/openapi.json")).json()) as {
    paths: Record<string, Record<string, { requestBody?: { content: Record<string, { schema: Schema }> } }>>;
  };
  const body = spec.paths["/v0/projects/{idOrSlug}/charts"]?.post?.requestBody?.content["application/json"]?.schema;

  it("chart create endpoint still exists", () => expect(body?.properties).toBeDefined());

  it("chart types match", () => {
    expect([...(unwrap(body?.properties?.chartType)?.enum ?? [])].sort()).toEqual([...CHART_TYPES].sort());
  });

  it("visual option groups match", () => {
    const vo = unwrap(unwrap(body?.properties?.queryConfig)?.properties?.visualOptions);
    expect(Object.keys(vo?.properties ?? {}).sort()).toEqual(Object.keys(VisualOptions.shape).sort());
  });

  it("preview endpoint still exists", () => {
    expect(spec.paths["/v0/projects/{idOrSlug}/metrics/preview"]?.post).toBeDefined();
  });
});
