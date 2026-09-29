import { defineConfig } from "tsup"

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/serve.ts",
    "src/cli.ts",
    "src/sdk.ts",
    "src/plugin.ts",
    "src/commands/start.ts",
    "src/commands/session.ts",
    "src/commands/pair.ts",
    "src/commands/install-mcp.ts",
  ],
  format: ["esm"],
  target: "es2022",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  dts: { entry: ["src/sdk.ts", "src/plugin.ts", "src/cli.ts", "src/serve.ts"] },
  splitting: true, // one copy of module-level state (recipe registry, hooks, session sources, platform kit) shared by index/serve/sdk/plugin
  skipNodeModulesBundle: true,
})
