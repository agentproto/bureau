/**
 * @agentproto/bureau-sdk/react — framework glue. Styling-free by design: the hook
 * manages state, the host renders with its own design system. `useBureau`
 * consumes a Bureau's snapshot; `useBureauWatch` consumes one tab's live frame
 * stream — both transport-injected, neither carrying a host URL or auth scheme.
 */

export { useBureau, type UseBureauResult } from "./use-bureau.js"
export {
  useBureauWatch,
  type UseBureauWatchOptions,
  type UseBureauWatchResult,
  type WatchStatus,
} from "./use-bureau-watch.js"
export type {
  BureauStatus,
  BureauSession,
  BureauTab,
  BureauSnapshot,
  BureauMachine,
  BureauFrame,
} from "../schemas.js"
