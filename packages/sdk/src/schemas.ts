/**
 * The wire shapes a Bureau capability server returns — the single source of
 * truth for both consumers (a hosted panel over a tunnel, and the packaged
 * Bureau app over local HTTP). Metadata only: a saved identity is named by `id`
 * and tagged by platform/account, never by its cookie bytes.
 */

import { z } from "zod"

/** A saved login identity the Bureau holds (one cookie jar per platform login). */
export const bureauSessionSchema = z.object({
  id: z.string(),
  backend: z.string().optional(),
  platform: z.string().optional(),
  account: z.string().optional(),
  source: z.string().optional(),
  domains: z.array(z.string()).optional(),
})
export type BureauSession = z.infer<typeof bureauSessionSchema>

/** A browser tab the Bureau currently has open, attributed to its session. */
export const bureauTabSchema = z.object({
  session: z.string(),
  tabId: z.string(),
  url: z.string(),
  title: z.string(),
})
export type BureauTab = z.infer<typeof bureauTabSchema>

/**
 * What the client can observe directly from ONE Bureau: whether the daemon
 * answered, and the sessions + tabs it reported. `connected` is liveness, not
 * configuration.
 */
export const bureauSnapshotSchema = z.object({
  connected: z.boolean(),
  sessions: z.array(bureauSessionSchema),
  tabs: z.array(bureauTabSchema),
})
export type BureauSnapshot = z.infer<typeof bureauSnapshotSchema>

/**
 * One machine's Bureau: a snapshot tagged with the daemon that owns it. A user
 * can run a Bureau on several machines (laptop + desktop); each is addressed by
 * its `daemonId` and labelled for the picker. This is the unit the watch UI
 * targets — you watch a machine, not "the Bureau".
 */
export const bureauMachineSchema = bureauSnapshotSchema.extend({
  daemonId: z.string(),
  label: z.string().optional(),
  platform: z.string().optional(),
})
export type BureauMachine = z.infer<typeof bureauMachineSchema>

/**
 * The host-facing envelope: whether a Bureau is linked at all (`configured`,
 * host-decided — e.g. "a connector exists for this user") plus the per-machine
 * list. Empty `machines` with `configured: true` = linked but every machine
 * offline; the client never invents `configured`.
 */
export const bureauStatusSchema = z.object({
  configured: z.boolean(),
  machines: z.array(bureauMachineSchema),
  /**
   * Whether the host can stand up a CLOUD Bureau on demand (no machine of the
   * user's own). Lets the UI offer "start a cloud browser" as a first-class
   * opt-in beside "connect your machine". Optional: a packaged local-only app
   * omits it (treat absent as false).
   */
  cloudAvailable: z.boolean().optional(),
})
export type BureauStatus = z.infer<typeof bureauStatusSchema>

/**
 * One live screen frame from a watched tab. The wire shape every producer emits
 * and every consumer renders: chromium drains CDP `Page.startScreencast`,
 * camofox polls screenshots — both flatten to this. A pixel frame plus its tab
 * position in the stream; never any cookie or credential bytes.
 *
 * Mirrors `ScreencastFrame` in `@agentproto/bureau-core` (the producer-side
 * type) the same way `bureauSessionSchema` mirrors the server's session shape —
 * no cross-package dependency, the structures are kept identical by contract.
 */
export const bureauFrameSchema = z.object({
  /** Base64-encoded image bytes. */
  data: z.string(),
  format: z.enum(["jpeg", "png"]),
  /** ms epoch when the frame was captured. */
  timestampMs: z.number(),
  /** Monotonic index within the watch session. */
  index: z.number(),
})
export type BureauFrame = z.infer<typeof bureauFrameSchema>
