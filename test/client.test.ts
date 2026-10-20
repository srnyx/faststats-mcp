import { describe, expect, it, vi } from "vitest";
import { FastStatsClient, FastStatsError } from "../src/api/client";

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const client = (fetchImpl: typeof fetch) => new FastStatsClient({ apiKey: "fs_test", baseUrl: "https://api.example" }, fetchImpl);

describe("FastStatsClient", () => {
  it("sends the key in x-api-key and redacts the project token", async () => {
    const f = vi.fn(async () => json(200, { id: "1", name: "LL", slug: "limited-lives", templateId: "minecraft-plugin", token: "secret" }));
    const p = await client(f as never).getProject("limited-lives");
    const [url, init] = f.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe("https://api.example/v0/projects/limited-lives");
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("fs_test");
    expect(p).not.toHaveProperty("token");
  });

  it("retries 503 then succeeds", async () => {
    const f = vi.fn().mockResolvedValueOnce(json(503, {}, { "retry-after": "0" })).mockResolvedValueOnce(json(200, []));
    expect(await client(f).listDashboards("p")).toEqual([]);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("surfaces FastStats error messages", async () => {
    const f = vi.fn(async () => json(500, { _tag: "InternalServerError", message: "Field 'x' is not available for this dataset" }));
    await expect(client(f as never).listDashboards("p")).rejects.toThrow(/Field 'x' is not available/);
    await expect(client(f as never).listDashboards("p")).rejects.toBeInstanceOf(FastStatsError);
  });

  it("explains auth failures", async () => {
    const f = vi.fn(async () => json(401, { message: "Unauthorized" }));
    await expect(client(f as never).listDashboards("p")).rejects.toThrow(/FASTSTATS_API_KEY/);
  });

  it("handles 204 responses", async () => {
    const f = vi.fn(async () => new Response(null, { status: 204 }));
    await expect(client(f as never).deleteChart("p", "c")).resolves.toBeUndefined();
  });

  it("paginates projects", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(json(200, { items: [{ id: "1", name: "a", slug: "a" }], hasMore: true }))
      .mockResolvedValueOnce(json(200, { items: [{ id: "2", name: "b", slug: "b" }], hasMore: false }));
    expect((await client(f).listProjects()).map((p) => p.slug)).toEqual(["a", "b"]);
  });
});
