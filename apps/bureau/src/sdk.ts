/**
 * Public plugin SDK: everything a plugin (e.g. a plugin package)
 * needs from core, behind one import path (`@agentproto/bureau/sdk`) so plugins
 * never reach into core's internal file layout.
 *
 * Module state (the recipe registry, workflow hooks, session sources) lives in
 * core's own modules; a plugin must import them through this barrel so it
 * shares the single instance the running server reads.
 */

export * from "./mcp-tool.js"
export * from "./plugin.js"
export * from "./lib/ports.js"
export * from "./lib/sessions.js"
export * from "./lib/platform-kit.js"
export * from "./lib/human-session.js"
export * from "./lib/session-persist.js"
export * from "./lib/credentials.js"
export * from "./lib/recipe-types.js"
export * from "./lib/recipe-registry.js"
export * from "./lib/bindings.js"
export * from "./lib/workflow-hooks.js"
export * from "./lib/run-workflow.js"
export * from "./lib/args.js"
export * from "./lib/notifier.js"
export * from "./lib/recorder.js"
export { definePageRecipe, readPage } from "./recipes/index.js"
export type { PageRecipeSpec } from "./recipes/index.js"
