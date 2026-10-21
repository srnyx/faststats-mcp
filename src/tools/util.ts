import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { FastStatsError } from "../api/client";
import { log } from "../log";
import { UserError } from "../service";

export const RO = { readOnlyHint: true, openWorldHint: true } as const;

export const projectArg = z
  .string()
  .optional()
  .describe("Project slug or id. Optional when FASTSTATS_DEFAULT_PROJECT is set.");

/** Drops undefined values so PATCH bodies only carry what the caller set. */
export const defined = <T extends Record<string, unknown>>(o: T) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

/** FastStats times are Unix seconds or milliseconds (below 1e12 means seconds). */
export const iso = (t: number | string) => {
  const n = Number(t);
  return Number.isFinite(n) ? new Date(n < 1e12 ? n * 1000 : n).toISOString() : t;
};

export const ok = (value: unknown): CallToolResult => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});

export const fail = (message: string, extra?: Record<string, unknown>): CallToolResult => ({
  isError: true,
  content: [{ type: "text", text: JSON.stringify({ error: message, ...extra }, null, 2) }],
});

/** Converts thrown errors into tool errors Claude can act on. */
export const guard =
  <A>(name: string, fn: (args: A) => Promise<CallToolResult>) =>
  async (args: A): Promise<CallToolResult> => {
    try {
      return await fn(args);
    } catch (err) {
      if (err instanceof UserError || err instanceof FastStatsError) return fail(err.message);
      log.error(`${name} crashed`, (err as Error).stack ?? String(err));
      return fail(`Unexpected error in ${name}: ${(err as Error).message}`);
    }
  };
