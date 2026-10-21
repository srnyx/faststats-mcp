import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

/**
 * Rewrites every `"type": [...]` in a JSON Schema into single-type `anyOf` branches. zod v4 emits type arrays
 * for unions of bare types and for `.nullable()`, which some clients (e.g. Gemini's OpenAPI subset) reject.
 */
export function portableSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(portableSchema);
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) out[k] = portableSchema(v);
  if (!Array.isArray(out.type)) return out;

  const { type, ...rest } = out as { type: unknown[] } & Record<string, unknown>;
  const branches = type.map((t) => ({ type: t }));
  if (!rest.anyOf) return { ...rest, anyOf: branches };
  const { anyOf, ...others } = rest;
  return { ...others, allOf: [{ anyOf }, { anyOf: branches }] };
}

/** Makes outgoing tools/list results use portable schemas; the SDK builds them internally, so this is the one place to hook. */
export function withPortableToolSchemas<T extends Transport>(transport: T): T {
  const send = transport.send.bind(transport);
  transport.send = (message, options) => {
    const result = (message as { result?: { tools?: unknown } }).result;
    if (!Array.isArray(result?.tools)) return send(message, options);
    const tools = result.tools.map((t: Record<string, unknown>) => ({
      ...t,
      ...(t.inputSchema ? { inputSchema: portableSchema(t.inputSchema) } : {}),
      ...(t.outputSchema ? { outputSchema: portableSchema(t.outputSchema) } : {}),
    }));
    return send({ ...message, result: { ...result, tools } } as typeof message, options);
  };
  return transport;
}
