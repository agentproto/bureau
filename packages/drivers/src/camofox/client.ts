/**
 * CamofoxClient — the structural port the camofox driver needs from a
 * Camofox REST client. Declaring it here (instead of importing the
 * concrete `CamofoxBrowserProvider` from the legacy integration package)
 * keeps `@agentproto/bureau-drivers` standalone-pure: the concrete client
 * is INJECTED at the composition edge, where the integration dependency
 * legitimately lives. Any object with these methods satisfies it — the
 * legacy `CamofoxBrowserProvider` does, structurally.
 *
 * Only the slice the driver actually calls is modelled; option bags are
 * the minimal shapes the driver passes, so the richer concrete signatures
 * remain assignable.
 */

import type { CookieJson } from "@agentproto/bureau-core"

export interface CamofoxNavigateOptions {
  readonly waitUntil?: "load" | "domcontentloaded" | "networkidle2"
  readonly timeout?: number
}

export interface CamofoxScreenshotOptions {
  readonly selector?: string
  readonly format?: string
  readonly quality?: number
}

/**
 * Typing realism passed to the camofox `/type` endpoint. `human: true` makes the
 * service type keystroke-by-keystroke with `delay` ms of jitter between keys;
 * omitted (or `human: false`) sets the field value in one shot.
 */
export interface CamofoxTypeOptions {
  readonly human?: boolean
  readonly delay?: number
}

/** What `executeScript` resolves to — the driver reads `value` and `error`. */
export interface CamofoxScriptResult<T = unknown> {
  readonly value?: T
  readonly error?: string
}

/** One live browser tab as reported by camofox `GET /tabs`. */
export interface CamofoxTab {
  readonly tabId: string
  readonly url: string
  readonly title: string
  /** Tab-group key under the userId context (camofox `listItemId`). */
  readonly listItemId?: string
}

export interface CamofoxClient {
  createSession(): Promise<{ id: string }>
  navigate(
    sessionId: string,
    url: string,
    options?: CamofoxNavigateOptions
  ): Promise<void>
  click(sessionId: string, selector: string): Promise<void>
  type(
    sessionId: string,
    selector: string,
    value: string,
    options?: CamofoxTypeOptions
  ): Promise<void>
  getScreenshot(
    sessionId: string,
    options?: CamofoxScreenshotOptions
  ): Promise<Buffer>
  executeScript<T = unknown>(
    sessionId: string,
    script: string
  ): Promise<CamofoxScriptResult<T>>
  getRecordedVideo(sessionId: string): Promise<Buffer>
  setCookies(sessionId: string, cookies: CookieJson[]): Promise<unknown>
  closeSession(sessionId: string): Promise<void>
}

/**
 * Concrete client surface — the structural {@link CamofoxClient} port the
 * driver needs, plus read-only introspection the Bureau capability server
 * uses (and the driver doesn't). Kept off `CamofoxClient` so the legacy
 * provider's conformance check isn't forced to grow methods it doesn't have.
 */
export interface CamofoxRestClient extends CamofoxClient {
  /** Live tabs open under a userId context (empty if the session isn't live). */
  listTabs(userId: string): Promise<CamofoxTab[]>
}

export interface CamofoxRestClientConfig {
  /** Service base URL. Default: $CAMOFOX_URL or http://127.0.0.1:9377. */
  baseUrl?: string
  /**
   * Context id — logins (cookies) live at this level, so every tab under it
   * is already signed in. Default "main" (the persistent profile session).
   */
  userId?: string
  /** Session key under the userId context. Default "main". */
  sessionKey?: string
  /**
   * Camofox API key sent as `Authorization: Bearer <key>`. Required when the
   * Camofox service enforces auth (`CAMOFOX_API_KEY` set in its env). Defaults
   * to `process.env.CAMOFOX_API_KEY` so callers that inherit the env don't
   * need to plumb it through explicitly. Never logged.
   */
  apiKey?: string
}

/**
 * Concrete CamofoxClient over the Camofox service REST API — the vendor-neutral
 * client the driver injects, replacing the legacy CamofoxBrowserProvider.
 * A `session` here is a server tab; the driver owns its lifecycle (create →
 * use → close), so this client is stateless (no tab caching).
 *
 * `127.0.0.1`, not `localhost` — node/undici resolves localhost→::1 (IPv6)
 * first, but the service is IPv4-only (else ECONNREFUSED). The Camofox
 * `/evaluate` endpoint runs `page.evaluate(expression)` server-side and wraps
 * nothing, so `executeScript` wraps the body in an IIFE — multi-statement
 * scripts return via an explicit `return`, matching the driver's convention.
 */
export function createCamofoxRestClient(
  config: CamofoxRestClientConfig = {}
): CamofoxRestClient {
  const base = (
    config.baseUrl ??
    process.env.CAMOFOX_URL ??
    "http://127.0.0.1:9377"
  ).replace("localhost", "127.0.0.1")
  const userId = config.userId ?? "main"
  const sessionKey = config.sessionKey ?? "main"
  const apiKey = config.apiKey ?? process.env.CAMOFOX_API_KEY

  const authHeaders = (): Record<string, string> =>
    apiKey ? { Authorization: `Bearer ${apiKey}` } : {}

  const json = async <T = unknown>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> => {
    const res = await fetch(base + path, {
      method,
      headers: { "content-type": "application/json", ...authHeaders() },
      body: body ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    // Surface backend failures instead of returning them as if they were a
    // normal body: camofox answers a 4xx/5xx with a JSON `{ error }` (e.g. its
    // own `withTimeout` handler budget aborting a long human-paced fill).
    // Swallowing non-2xx here made a driver call resolve normally — and the
    // MCP tool report success — while the server had already abandoned the
    // operation mid-call (salvage: refs/salvage/stash/2026-09-03-14, dogfood
    // 2026-09-03: silent form corruption traced to exactly this).
    if (!res.ok) {
      const detail = text.slice(0, 300)
      throw new Error(
        `camofox ${method} ${path}: HTTP ${res.status}${detail ? `: ${detail}` : ""}`
      )
    }
    return (text ? JSON.parse(text) : {}) as T
  }

  const binary = async (method: string, path: string): Promise<Buffer> => {
    const res = await fetch(base + path, { method, headers: authHeaders() })
    if (!res.ok) throw new Error(`camofox ${path}: HTTP ${res.status}`)
    return Buffer.from(await res.arrayBuffer())
  }

  const q = (params: Record<string, string | undefined>): string => {
    const sp = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) if (v != null) sp.set(k, v)
    return sp.toString()
  }

  return {
    async createSession() {
      const r = await json<{ tabId?: string; error?: string }>(
        "POST",
        "/tabs",
        { userId, sessionKey }
      )
      if (!r.tabId)
        throw new Error(`camofox /tabs: ${r.error ?? "no tabId returned"}`)
      return { id: r.tabId }
    },

    async navigate(sessionId, url, options) {
      await json("POST", `/tabs/${sessionId}/navigate`, {
        userId,
        url,
        waitUntil: options?.waitUntil,
        timeout: options?.timeout,
      })
    },

    async click(sessionId, selector) {
      await json("POST", `/tabs/${sessionId}/click`, { userId, selector })
    },

    async type(sessionId, selector, value, options) {
      await json("POST", `/tabs/${sessionId}/type`, {
        userId,
        selector,
        text: value,
        // Only stamp the human flags when asked — a bare type stays an instant
        // value-set, so existing callers are unchanged.
        ...(options?.human ? { human: true, delay: options.delay ?? 90 } : {}),
      })
    },

    async getScreenshot(sessionId, options) {
      return binary(
        "GET",
        `/tabs/${sessionId}/screenshot?${q({
          userId,
          selector: options?.selector,
          format: options?.format,
          quality: options?.quality?.toString(),
        })}`
      )
    },

    async executeScript<T = unknown>(sessionId: string, script: string) {
      const r = await json<{ result?: T; error?: string }>(
        "POST",
        `/tabs/${sessionId}/evaluate`,
        { userId, expression: `(function(){ ${script} })()` }
      )
      return r.error ? { error: r.error } : { value: r.result }
    },

    async getRecordedVideo(sessionId) {
      return binary("GET", `/tabs/${sessionId}/video?${q({ userId })}`)
    },

    async setCookies(sessionId, cookies) {
      return json("POST", `/sessions/${encodeURIComponent(userId)}/cookies`, {
        cookies,
        sessionKey,
      })
    },

    async closeSession(sessionId) {
      await json("DELETE", `/tabs/${sessionId}?${q({ userId })}`)
    },

    async listTabs(forUserId) {
      const r = await json<{ running?: boolean; tabs?: CamofoxTab[] }>(
        "GET",
        `/tabs?${q({ userId: forUserId })}`
      )
      return r.tabs ?? []
    },
  }
}
