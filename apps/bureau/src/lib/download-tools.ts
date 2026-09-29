/**
 * `browser_download` — trigger and capture a same-tab file download in a
 * saved session's pooled tab (M1-GAPS.md gap 3, lane B1).
 *
 * Bureau has no native download tool: `browser_export` renders the tab
 * (print), it doesn't save a served file, and navigating a tab to a URL that
 * responds with `Content-Disposition: attachment` makes Playwright/camofox
 * reject the navigation with a "Download is starting" error instead of
 * landing the bytes anywhere reachable. Camofox itself DOES capture the
 * download server-side (it attaches a `page.on('download', ...)` listener to
 * every tab at creation — `attachDownloadListener` in the fork's
 * `lib/downloads.js`) and exposes it read-only at
 * `GET /tabs/:tabId/downloads?includeData=true&maxBytes=…`
 * (camofox-browser `server.js`, download handler).
 * This tool triggers the download through the session's own pooled
 * `HumanSession` (so it runs in the identity's authenticated tab, not an
 * anonymous one), then polls that REST endpoint directly for the bytes.
 * Read-only against camofox — no camofox code changes.
 *
 * Tab discovery: a `HumanSession` (the `active-driver-pool` abstraction)
 * deliberately doesn't expose its camofox `tabId`, so this tool re-derives it
 * the same way `camofox-session.ts`'s `openSession` does internally: list the
 * session's live tabs (`GET /tabs?userId=<session>`) and take the one tab —
 * the pool guarantees at most one live tab per session id, the same one every
 * `browser_act` / session-aware `browser_navigate` call already reuses.
 */

import { createHash } from "node:crypto"
import { z } from "zod"
import type { HumanSession } from "./ports.js"
import { defaultCamofoxBase } from "@agentproto/browser-profiles"
import { writeArtifact } from "@agentproto/bureau-core/artifacts"
import { asContent, toInputSchema, type McpEntry } from "../mcp-tool.js"

/** Refuse a download whose reported size exceeds this — matches the query
 *  `maxBytes` sent to camofox, so an oversized file comes back with
 *  `dataSkipped` rather than a huge inline base64 payload. */
export const BROWSER_DOWNLOAD_MAX_BYTES = 25 * 1024 * 1024

export const BROWSER_DOWNLOAD_DEFAULT_TIMEOUT_MS = 30_000
const BROWSER_DOWNLOAD_MIN_TIMEOUT_MS = 1_000
const BROWSER_DOWNLOAD_MAX_TIMEOUT_MS = 120_000
const DEFAULT_POLL_INTERVAL_MS = 400

/** Playwright/camofox's rejection message when a navigation turns into a
 *  download instead of landing a page — the EXPECTED outcome of the trigger
 *  step, not a failure. Matched loosely (case-insensitively, substring) since
 *  the exact wording is Playwright's, not ours to pin exactly. */
const DOWNLOAD_STARTING_RE = /download/i

function sanitizeFileName(value: string): string {
  const cleaned = String(value || "download.bin")
    .replace(/[\\/:*?"<>|\u0000-\u001F]/g, "_")
    .trim()
    .slice(0, 200)
  return cleaned || "download.bin"
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

interface CamofoxTab {
  tabId: string
}

interface CamofoxDownloadEntry {
  id: string
  url: string
  suggestedFilename: string
  mimeType: string
  bytes: number | null
  createdAt: string
  failure: string | null
  dataBase64?: string
  dataSkipped?: string
  readError?: string
}

async function listCamofoxTabs(
  fetchImpl: typeof fetch,
  base: string,
  session: string
): Promise<CamofoxTab[]> {
  const res = await fetchImpl(
    `${base}/tabs?userId=${encodeURIComponent(session)}`
  )
  if (!res.ok) {
    throw new Error(`browser_download: camofox GET /tabs -> ${res.status}`)
  }
  const body = (await res.json()) as { tabs?: CamofoxTab[] }
  return body.tabs ?? []
}

async function listCamofoxDownloads(
  fetchImpl: typeof fetch,
  base: string,
  session: string,
  tabId: string,
  maxBytes: number
): Promise<CamofoxDownloadEntry[]> {
  const qs = new URLSearchParams({
    userId: session,
    includeData: "true",
    maxBytes: String(maxBytes),
  })
  const res = await fetchImpl(
    `${base}/tabs/${encodeURIComponent(tabId)}/downloads?${qs.toString()}`
  )
  if (!res.ok) {
    throw new Error(
      `browser_download: camofox GET /tabs/:tabId/downloads -> ${res.status}`
    )
  }
  const body = (await res.json()) as { downloads?: CamofoxDownloadEntry[] }
  return body.downloads ?? []
}

export interface DownloadToolDeps {
  resolvePooledDriver: (id: string) => Promise<HumanSession>
  /** camofox REST base; defaults to CAMOFOX_URL / :9377 (same default as the
   *  rest of the session layer). Injectable so tests never touch a real port. */
  camofoxBase?: string
  /** Injectable for hermetic tests — a fake implementing just the two camofox
   *  routes this tool calls. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
  /** Poll cadence while waiting for the download to land. Injectable so tests
   *  don't have to wait real wall-clock milliseconds. */
  pollIntervalMs?: number
}

const inputSchema = z.object({
  session: z
    .string()
    .min(1)
    .describe("Saved logged-in identity whose pooled tab drives the download."),
  url: z
    .string()
    .optional()
    .describe(
      "Absolute http(s) URL to navigate to — a download-triggering link " +
        "(e.g. a PDF with Content-Disposition: attachment). Mutually usable " +
        "with `selector`; at least one is required."
    ),
  selector: z
    .string()
    .optional()
    .describe(
      "CSS selector of an element to click that triggers a download, " +
        "instead of navigating to `url`."
    ),
  timeoutMs: z
    .number()
    .optional()
    .describe(
      `Max wait for the download to land, ` +
        `${BROWSER_DOWNLOAD_MIN_TIMEOUT_MS}-${BROWSER_DOWNLOAD_MAX_TIMEOUT_MS} ` +
        `(default ${BROWSER_DOWNLOAD_DEFAULT_TIMEOUT_MS}).`
    ),
})

function clampTimeout(input: number | undefined): number {
  if (typeof input !== "number" || !Number.isFinite(input)) {
    return BROWSER_DOWNLOAD_DEFAULT_TIMEOUT_MS
  }
  return Math.min(
    BROWSER_DOWNLOAD_MAX_TIMEOUT_MS,
    Math.max(BROWSER_DOWNLOAD_MIN_TIMEOUT_MS, input)
  )
}

/** Build the `browser_download` McpEntry. */
export function createDownloadEntry(deps: DownloadToolDeps): McpEntry {
  const base = (deps.camofoxBase ?? defaultCamofoxBase()).replace(/\/$/, "")
  const fetchImpl = deps.fetchImpl ?? fetch
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS

  return {
    name: "browser_download",
    description:
      "Trigger a file download in a saved session's own tab and save it to " +
      "the Bureau host (no base64 in the tool result — returns metadata + " +
      "the file path). Pass `url` (a download-triggering link, e.g. a PDF) " +
      "or `selector` (an element to click that starts the download). Only " +
      "http(s) URLs are accepted; downloads over " +
      `${BROWSER_DOWNLOAD_MAX_BYTES} bytes are refused. Use for a file a ` +
      "page serves rather than renders — the write counterpart to `scrape` " +
      "for an actual attachment instead of readable text.",
    jsonSchema: toInputSchema(inputSchema),
    call: async args => {
      const o = inputSchema.parse(args)
      if (!o.url && !o.selector) {
        throw new Error("browser_download: `url` or `selector` is required")
      }
      if (o.url) {
        let parsed: URL
        try {
          parsed = new URL(o.url)
        } catch {
          throw new Error(
            "browser_download: `url` must be an absolute http(s) URL"
          )
        }
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          throw new Error("browser_download: only http(s) URLs are allowed")
        }
      }
      const timeoutMs = clampTimeout(o.timeoutMs)
      const startedAt = Date.now()
      const deadline = () => Date.now() - startedAt > timeoutMs

      const human = await deps.resolvePooledDriver(o.session)

      // Baseline: this session's existing tab (if any) and its already-
      // captured downloads, so the poll below waits for a NEW entry rather
      // than possibly returning a stale one from an earlier call.
      const existingTabId = (
        await listCamofoxTabs(fetchImpl, base, o.session).catch(() => [])
      )[0]?.tabId
      const baselineIds = new Set(
        existingTabId
          ? (
              await listCamofoxDownloads(
                fetchImpl,
                base,
                o.session,
                existingTabId,
                BROWSER_DOWNLOAD_MAX_BYTES
              ).catch(() => [])
            ).map(d => d.id)
          : []
      )

      // Trigger. A download-triggering navigation makes camofox/Playwright
      // reject with a "Download is starting"-shaped error — the expected
      // outcome, not a failure. Any other error propagates.
      try {
        if (o.url) await human.navigate(o.url)
        else await human.click(o.selector as string)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (!DOWNLOAD_STARTING_RE.test(msg)) throw err
      }

      // Resolve the tab id (poll — the tab may have only just been created by
      // the trigger above).
      let tabId = existingTabId
      while (!tabId) {
        tabId = (await listCamofoxTabs(fetchImpl, base, o.session))[0]?.tabId
        if (tabId) break
        if (deadline()) {
          throw new Error(
            `browser_download: no tab found for session "${o.session}"`
          )
        }
        await sleep(pollIntervalMs)
      }
      const resolvedTabId = tabId

      // Poll for a fresh (not-in-baseline) capture matching `url`, when given.
      let found: CamofoxDownloadEntry | undefined
      for (;;) {
        const downloads = await listCamofoxDownloads(
          fetchImpl,
          base,
          o.session,
          resolvedTabId,
          BROWSER_DOWNLOAD_MAX_BYTES
        )
        const fresh = downloads.filter(d => !baselineIds.has(d.id))
        found = o.url
          ? (fresh.find(d => d.url === o.url) ?? fresh.at(-1))
          : fresh.at(-1)
        if (found) break
        if (deadline()) {
          throw new Error(
            `browser_download: no download captured within ${timeoutMs}ms` +
              (o.url ? ` for ${o.url}` : "")
          )
        }
        await sleep(pollIntervalMs)
      }

      if (found.failure) {
        throw new Error(`browser_download: download failed: ${found.failure}`)
      }
      if (found.dataSkipped) {
        throw new Error(
          `browser_download: file too large (${found.bytes ?? "?"} bytes, ` +
            `max ${BROWSER_DOWNLOAD_MAX_BYTES})`
        )
      }
      if (!found.dataBase64) {
        throw new Error(
          `browser_download: no data captured (${found.readError ?? "unknown reason"})`
        )
      }

      const bytes = Buffer.from(found.dataBase64, "base64")
      const sha256 = createHash("sha256").update(bytes).digest("hex")
      const fileName = sanitizeFileName(found.suggestedFilename)
      const path = writeArtifact(
        `downloads/${o.session}/${Date.now()}-${fileName}`,
        bytes
      )

      return asContent({
        fileName,
        mimeType: found.mimeType,
        sizeBytes: bytes.length,
        sha256,
        path,
      })
    },
  }
}
