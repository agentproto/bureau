/**
 * Browser session domain — agnostic types + port + cookie/localStorage injector.
 * DB persistence (base-columns, service) lives in a separate store adapter.
 */

export {
  browserSessionPayloadSchema,
  cookieJsonSchema,
  localStorageSnapshotSchema,
  syncBrowserSessionInputSchema,
  BROWSER_SESSION_SCOPES,
  BROWSER_SESSION_STATUSES,
  type BrowserSessionStatus,
  type BrowserSessionPayload,
  type BrowserSessionMetadata,
  type CookieJson,
  type LocalStorageSnapshot,
  type SyncBrowserSessionInput,
} from "./types.js"

export {
  injectSession,
  injectLocalStorage,
  selectLocalStorageForUrl,
  type CookieInjectorCapable,
  type InjectSessionResult,
} from "./injector.js"

export type { BrowserSessionProvider } from "./provider.js"
