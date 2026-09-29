/**
 * @agentproto/bureau-sdk — typed consumption of a Bureau capability server.
 *
 * The server lives in `@agentproto/bureau-mcp` (produces the tools); this is the
 * client (validated reads + a one-shot snapshot). Inject a transport — local
 * HTTP for the packaged app, a tunnel bridge for a connected cloud — and the
 * same client serves both. Vendor-neutral: no app-specific imports.
 */

export { createBureauClient, type BureauClient } from "./client.js"
export {
  createHttpTransport,
  type BureauTransport,
  type BureauToolResult,
} from "./transport.js"
export {
  bureauSessionSchema,
  bureauTabSchema,
  bureauSnapshotSchema,
  bureauMachineSchema,
  bureauStatusSchema,
  bureauFrameSchema,
  type BureauSession,
  type BureauTab,
  type BureauSnapshot,
  type BureauMachine,
  type BureauStatus,
  type BureauFrame,
} from "./schemas.js"
export {
  STOP_SENTINEL,
  parseFrameMessage,
  appendBounded,
} from "./watch-frames.js"
export {
  bureauEndpoint,
  type BureauEndpoint,
  type BureauTransportOptions,
  type WatchUrlOptions,
  type ProvisionedBureau,
  type BureauRuntime,
  type BureauProvisionInput,
} from "./endpoint.js"
export {
  registerBureauRuntime,
  resolveBureauRuntime,
  listBureauRuntimeKinds,
} from "./registry.js"
export {
  cachedBureauRuntime,
  type CachedBureauRuntimeOptions,
} from "./cached-runtime.js"
