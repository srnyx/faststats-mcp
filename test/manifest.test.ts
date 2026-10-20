// Keeps the Claude Desktop extension manifest in sync with the code.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import pkg from "../package.json";
import { loadConfig } from "../src/config";
import { registerTools } from "../src/tools/index";

const manifest = JSON.parse(readFileSync(fileURLToPath(new URL("../manifest.json", import.meta.url)), "utf8")) as {
  version: string;
  tools: { name: string }[];
  server: { mcp_config: { env: Record<string, string> } };
  user_config: Record<string, unknown>;
};

const registered = (readOnly: boolean) => {
  const names: string[] = [];
  registerTools({ registerTool: (name: string) => names.push(name) } as never, {} as never, { readOnly });
  return names;
};

describe("manifest.json", () => {
  it("has the same version as package.json", () => expect(manifest.version).toBe(pkg.version));

  it("lists exactly the tools the server registers", () => {
    expect(manifest.tools.map((t) => t.name).sort()).toEqual(registered(false).sort());
  });

  it("only maps env vars to user_config keys that exist", () => {
    for (const value of Object.values(manifest.server.mcp_config.env)) {
      const key = /^\$\{user_config\.(\w+)\}$/.exec(value)?.[1];
      expect(key && key in manifest.user_config, value).toBe(true);
    }
  });
});

describe("config from the extension's env", () => {
  it("treats Claude Desktop's substituted values correctly", () => {
    const c = loadConfig({ FASTSTATS_API_KEY: " key ", FASTSTATS_DEFAULT_PROJECT: "", FASTSTATS_READ_ONLY: "false" });
    expect(c).toMatchObject({ apiKey: "key", defaultProject: undefined, readOnly: false });
    expect(loadConfig({ FASTSTATS_API_KEY: "k", FASTSTATS_READ_ONLY: "true" }).readOnly).toBe(true);
  });

  it("hides write tools in read-only mode", () => {
    expect(registered(true)).not.toContain("create_chart");
    expect(registered(true)).toContain("preview_chart");
  });
});
