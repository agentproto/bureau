import { defineConfig } from "tsup"

export default defineConfig({
  entry: {
    index: "src/index.ts",
    driver: "src/driver/index.ts",
    notify: "src/notify/index.ts",
    recorder: "src/recording/session-recording.ts",
    artifacts: "src/driver/artifacts.ts",
    "page-eval": "src/page-eval/index.ts",
  },
  format: ["esm"],
  target: "es2022",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  dts: true,
  splitting: false,
  external: ["zod", "playwright"],
})
