import { defineConfig } from "vitest/config";
import { readFileSync } from "node:fs";

export default defineConfig({
  plugins: [
    {
      name: "md-as-text",
      transform(_code, id) {
        if (id.endsWith(".md")) return { code: `export default ${JSON.stringify(readFileSync(id, "utf8"))};`, map: null };
      },
    },
  ],
  test: { include: ["test/**/*.test.ts"] },
});
