import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  outDir: "dist",
  clean: true,
  sourcemap: false,
  // Bundle every dependency so dist/index.js runs with plain `node`, no node_modules needed.
  noExternal: [/.*/],
  splitting: false,
  loader: { ".md": "text" },
  banner: {
    // Some bundled CJS deps call require(); give them one in ESM output.
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
});
