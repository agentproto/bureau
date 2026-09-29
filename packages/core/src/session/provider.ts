/**
 * BrowserSessionProvider — interface for the agent runner to look up a
 * user's synced browser sessions.
 *
 * Host apps implement this by wrapping their
 * `createBrowserSessionService({ db, table })` and register it with the
 * tool provider registry. Agent-tools consume only this interface.
 */

import type { BrowserSessionMetadata, BrowserSessionPayload } from "./types.js"

export interface BrowserSessionProvider {
  /**
   * Fetch a decrypted session payload for (userId, domain). Returns null
   * if the user has not synced anything for that domain (or the session
   * has been revoked / expired).
   *
   * The `label` argument lets callers target a specific labelled session
   * ("personal reddit" vs "work linkedin"). Default: any active session.
   */
  getDecryptedForDomain(
    userId: string,
    domain: string,
    label?: string
  ): Promise<BrowserSessionPayload | null>

  /**
   * Fetch a decrypted session payload by exact session id. Used when the
   * agent explicitly picks a session via `browser({ session: { id } })`.
   */
  getDecryptedById?(
    userId: string,
    sessionId: string
  ): Promise<BrowserSessionPayload | null>

  /**
   * List all of the user's sessions, metadata only (never decrypted).
   * Used by the `browser_sessions_list` agent tool so agents can discover
   * what logged-in sites they have access to.
   */
  list(userId: string): Promise<BrowserSessionMetadata[]>

  /**
   * Optional: record that a session was used at this moment. Updates
   * `lastUsedAt` so the UI can show "Agent used Reddit session 3h ago".
   */
  touch?(userId: string, domain: string, label?: string): Promise<void>
}
