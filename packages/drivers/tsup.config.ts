import { defineConfig } from "tsup"

export default defineConfig({
  entry: { index: "src/index.ts", "camofox/index": "src/camofox/index.ts", "mcp/index": "src/mcp/index.ts" },
  format: ["esm"],
  target: "es2022",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  dts: true,
})
