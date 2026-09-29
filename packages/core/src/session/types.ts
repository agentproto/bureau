/**
 * Types for browser-session domain.
 *
 * The `BrowserSessionPayload` is what gets encrypted and stored in
 * `encrypted_payload`. It's shaped after Playwright's cookie format so Camofox
 * can inject it directly into a Firefox BrowserContext.
 */

import { z } from "zod"

/** Session lifecycle. */
export const BROWSER_SESSION_STATUSES = [
  "active",
  "expired",
  "revoked",
] as const
export type BrowserSessionStatus = (typeof BROWSER_SESSION_STATUSES)[number]

/** A single cookie, in Playwright-compatible format. */
export const cookieJsonSchema = z.object({
  name: z.string(),
  value: z.string(),
  domain: z.string(),
  path: z.string().default("/"),
  httpOnly: z.boolean().optional(),
  secure: z.boolean().optional(),
  sameSite: z.enum(["Strict", "Lax", "None"]).optional(),
  expires: z.number().optional(),
})
export type CookieJson = z.infer<typeof cookieJsonSchema>

/** A per-origin localStorage snapshot: { "https://reddit.com": { key: value } } */
export const localStorageSnapshotSchema = z.record(
  z.string(),
  z.record(z.string(), z.string())
)
export type LocalStorageSnapshot = z.infer<typeof localStorageSnapshotSchema>

/** The full plaintext payload — what the extension sends and what Camofox replays. */
export const browserSessionPayloadSchema = z.object({
  cookies: z.array(cookieJsonSchema),
  localStorage: localStorageSnapshotSchema.optional(),
  capturedAt: z.iso.datetime().optional(), // ISO
})
export type BrowserSessionPayload = z.infer<typeof browserSessionPayloadSchema>

/** What the extension POSTs to the API when syncing. */
export const syncBrowserSessionInputSchema = z.object({
  domain: z.string().min(1).max(255),
  label: z.string().max(120).optional(),
  payload: browserSessionPayloadSchema,
  userAgent: z.string().optional(),
  extensionVersion: z.string().optional(),
  expiresAt: z.iso.datetime().optional(),
})
export type SyncBrowserSessionInput = z.infer<
  typeof syncBrowserSessionInputSchema
>

/** Metadata-only view (what the API returns when listing — no payload). */
export interface BrowserSessionMetadata {
  id: string
  userId: string
  domain: string
  label: string | null
  cookieCount: number
  hasLocalStorage: boolean
  userAgent: string | null
  extensionVersion: string | null
  /** Owner opt-in for cloud (e2b Bureau) use — see column doc. */
  cloudAllowed: boolean
  status: BrowserSessionStatus
  capturedAt: Date
  expiresAt: Date | null
  lastUsedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

/** Scopes used by API keys and OAuth clients for browser-session endpoints. */
export const BROWSER_SESSION_SCOPES = {
  READ: "browser_session:read",
  WRITE: "browser_session:write",
} as const
