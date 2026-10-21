import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { portableSchema, withPortableToolSchemas } from "../src/schema";
import { registerTools } from "../src/tools/index";

/** Paths of every node whose `type` is an array. */
function typeArrays(node: unknown, path = "$"): string[] {
  if (Array.isArray(node)) return node.flatMap((x, i) => typeArrays(x, `${path}[${i}]`));
  if (!node || typeof node !== "object") return [];
  const own = Array.isArray((node as { type?: unknown }).type) ? [path] : [];
  return [...own, ...Object.entries(node).flatMap(([k, v]) => typeArrays(v, `${path}.${k}`))];
}

async function listTools(portable: boolean) {
  const server = new McpServer({ name: "test", version: "0" });
  registerTools(server, {} as never, { readOnly: false });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(portable ? withPortableToolSchemas(serverSide) : serverSide);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
  const { tools } = await client.listTools();
  await client.close();
  return tools;
}

describe("portableSchema", () => {
  it("splits type arrays into anyOf branches and keeps other keywords", () => {
    expect(portableSchema({ type: ["string", "null"], description: "d" })).toEqual({ description: "d", anyOf: [{ type: "string" }, { type: "null" }] });
  });

  it("rewrites nested schemas and leaves single types, enums and property names alone", () => {
    const schema = {
      type: "object",
      properties: { type: { type: "string", enum: ["a", "b"] }, v: { type: ["string", "number", "boolean"] } },
      required: ["type", "v"],
    };
    expect(portableSchema(schema)).toEqual({
      type: "object",
      properties: { type: { type: "string", enum: ["a", "b"] }, v: { anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }] } },
      required: ["type", "v"],
    });
  });

  it("combines with an existing anyOf instead of overwriting it", () => {
    expect(portableSchema({ type: ["string", "null"], anyOf: [{ minLength: 1 }] })).toEqual({
      allOf: [{ anyOf: [{ minLength: 1 }] }, { anyOf: [{ type: "string" }, { type: "null" }] }],
    });
  });
});

describe("tools/list over the real SDK", () => {
  it("has type arrays without the wrapper (so this test means something)", async () => {
    const tools = await listTools(false);
    expect(tools.flatMap((t) => typeArrays(t.inputSchema)).length).toBeGreaterThan(0);
  });

  it("has no type arrays in any tool schema with the wrapper", async () => {
    const tools = await listTools(true);
    expect(tools.length).toBeGreaterThan(30);
    expect(tools.flatMap((t) => typeArrays(t.inputSchema, t.name))).toEqual([]);
  });
});
