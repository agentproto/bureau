/**
 * MCP tool catalog over the `BrowserDriver` interface. Written once; reused by
 * both the extension-side server (chrome.debugger backend) and the server-side
 * headless server (Playwright/CDP backend).
 *
 * Each entry holds the Zod input schema + a handler. Tunnel/transport code
 * converts the schema to JSON Schema for `tools/list` via `z.toJSONSchema()`.
 */

import { z } from "zod"
import {
  clickOptionsSchema,
  evaluateOptionsSchema,
  fillOptionsSchema,
  navigateOptionsSchema,
  screenshotOptionsSchema,
  type BrowserDriver,
  type BrowserDriverProvider,
  type BrowserTarget,
  type EvaluateResult,
  type NetworkRequestSummary,
  type ScreenshotOptions,
  type ScreenshotResult,
  type ScreenshotFileResult,
  type ScreenshotSegmentsResult,
} from "./types.js"

const listRequestsInputSchema = z.object({
  since: z.number().optional(),
  limit: z.number().int().positive().max(500).default(100),
})

const getRequestBodyInputSchema = z.object({
  requestId: z.string(),
})

const getDomInputSchema = z.object({
  selector: z.string().optional(),
  path: z
    .string()
    .optional()
    .describe(
      "Write the serialized HTML to a file instead of returning it inline " +
        "(a relative path lands in the artifacts dir). Preferred for large " +
        "pages so the bytes don't bloat the response."
    ),
})

const cdpSendInputSchema = z.object({
  method: z.string(),
  params: z.unknown().optional(),
})

/**
 * Each handler accepts `unknown` and parses with its own `inputSchema` at the
 * top — that's the validation boundary. Keeps the array type uniform without
 * fighting TypeScript variance on the generic handler signature.
 */
export interface BrowserMcpTool {
  name: string
  description: string
  inputSchema: z.ZodTypeAny
  handler: (input: unknown, driver: BrowserDriver) => Promise<unknown>
}

/**
 * Provider-level tools. Browser-wide ops (list/focus tabs, open tab) can't
 * be served from a tab-attached `BrowserDriver` — those use
 * `chrome.debugger.sendCommand` which is tab-scoped and refuses
 * browser-wide CDP methods like `Target.getTargets` with -32000 "Not
 * allowed". Provider-level tools talk to `chrome.tabs.*` (extension
 * API) instead.
 */
export interface BrowserProviderMcpTool {
  name: string
  description: string
  inputSchema: z.ZodTypeAny
  handler: (input: unknown, provider: BrowserDriverProvider) => Promise<unknown>
}

/**
 * Writes screenshot/export bytes to a path on the driver host and returns the
 * resolved absolute path. Injected (not imported) so the shared tool catalog
 * carries no `node:fs/path/os` reference — that keeps it bundleable into the
 * in-browser extension, which never writes to disk. Host callers
 * (Bureau/headless) pass {@link writeArtifact} from `./artifacts`.
 */
export type ArtifactWriter = (path: string, bytes: Buffer) => string

export interface CreateBrowserMcpToolsOptions {
  writeArtifact?: ArtifactWriter
}

/** Insert `-N` before the extension: "shot.png" + 2 → "shot-2.png". No
 *  extension → append plainly: "shot" + 2 → "shot-2". */
function segmentPath(basePath: string, index: number): string {
  const dot = basePath.lastIndexOf(".")
  const slash = Math.max(basePath.lastIndexOf("/"), basePath.lastIndexOf("\\"))
  if (dot > slash) {
    return `${basePath.slice(0, dot)}-${index}${basePath.slice(dot)}`
  }
  return `${basePath}-${index}`
}

/** Settle time after each scroll before capturing — lets lazy-loaded content
 *  (images, virtualized rows) paint before the shot. */
const FULL_PAGE_SEGMENT_SETTLE_MS = 250

/** Hard cap on segments so an infinite-scroll page can't spin forever. */
const MAX_FULL_PAGE_SEGMENTS = 40

interface PageScrollMetrics {
  scrollHeight: number
  viewportHeight: number
  viewportWidth: number
  scrollY: number
}

/**
 * Full-page fallback for drivers with no native full-page capture (Gecko/
 * Camofox — no CDP `captureBeyondViewport`). Scrolls in viewport-height
 * increments and writes one file per segment instead of stitching: no
 * image-compositing dependency, and each file stays a normal screenshot size.
 * Restores the page's original scroll position when done.
 */
async function captureFullPageAsSegments(
  driver: BrowserDriver,
  opts: ScreenshotOptions & { path: string },
  writeArtifact: ArtifactWriter
): Promise<ScreenshotSegmentsResult> {
  const metrics = await driver.evaluate<PageScrollMetrics>({
    expression:
      "({ scrollHeight: Math.max(document.documentElement.scrollHeight, " +
      "document.body ? document.body.scrollHeight : 0), " +
      "viewportHeight: window.innerHeight, viewportWidth: window.innerWidth, " +
      "scrollY: window.scrollY })",
    awaitPromise: true,
    returnByValue: true,
    maxResultBytes: 1_000,
  })
  const m = metrics.value
  if (!m || !m.viewportHeight) {
    throw new Error(
      "browser_screenshot: could not measure page dimensions for full-page capture"
    )
  }
  const wanted = Math.max(1, Math.ceil(m.scrollHeight / m.viewportHeight))
  const segments = Math.min(MAX_FULL_PAGE_SEGMENTS, wanted)
  const paths: string[] = []
  for (let i = 0; i < segments; i++) {
    const y = i * m.viewportHeight
    await driver.evaluate({
      expression:
        `(async () => { window.scrollTo(0, ${y}); ` +
        `await new Promise(r => setTimeout(r, ${FULL_PAGE_SEGMENT_SETTLE_MS})); ` +
        `return true; })()`,
      awaitPromise: true,
      returnByValue: true,
      maxResultBytes: 100,
    })
    const shot = await driver.screenshot({
      format: opts.format,
      quality: opts.quality,
      fullPage: false,
    })
    const bytes = Buffer.from(shot.base64, "base64")
    paths.push(writeArtifact(segmentPath(opts.path, i + 1), bytes))
  }
  await driver
    .evaluate({
      expression: `window.scrollTo(0, ${m.scrollY})`,
      awaitPromise: true,
      returnByValue: true,
      maxResultBytes: 100,
    })
    .catch(() => undefined)
  return {
    paths,
    format: opts.format,
    segments,
    viewportWidth: m.viewportWidth,
    viewportHeight: m.viewportHeight,
    totalHeight: m.scrollHeight,
    truncated: wanted > segments,
  }
}

export function createBrowserMcpTools(
  options: CreateBrowserMcpToolsOptions = {}
): BrowserMcpTool[] {
  return [
    {
      name: "browser_navigate",
      description:
        "Navigate the attached tab to a URL and wait for the chosen lifecycle event.",
      inputSchema: navigateOptionsSchema,
      handler: async (input, driver) => {
        const opts = navigateOptionsSchema.parse(input)
        await driver.navigate(opts)
        return { url: opts.url }
      },
    },
    {
      name: "browser_evaluate",
      description:
        "Evaluate a JavaScript expression in the page and return the value.",
      inputSchema: evaluateOptionsSchema,
      handler: async (input, driver): Promise<EvaluateResult> =>
        driver.evaluate(evaluateOptionsSchema.parse(input)),
    },
    {
      name: "browser_click",
      description: "Click an element by CSS selector.",
      inputSchema: clickOptionsSchema,
      handler: async (input, driver) => {
        const opts = clickOptionsSchema.parse(input)
        await driver.click(opts)
        return { selector: opts.selector }
      },
    },
    {
      name: "browser_fill",
      description: "Fill an input element by CSS selector.",
      inputSchema: fillOptionsSchema,
      handler: async (input, driver) => {
        const opts = fillOptionsSchema.parse(input)
        await driver.fill(opts)
        return { selector: opts.selector }
      },
    },
    {
      name: "browser_screenshot",
      description:
        "Capture a screenshot of the page or a CSS-selected region. Returns " +
        "base64 by default; pass `path` to write the image to a file and return " +
        "its path instead (strongly preferred for full-page / large captures, " +
        "so the bytes don't bloat the response). `fullPage` captures the whole " +
        "scrollable page, not just the viewport — on drivers with native CDP " +
        "support that's one image; on Gecko/Camofox (no CDP full-page capture) " +
        "it instead scrolls in viewport-height steps and writes one file per " +
        "segment (`path` becomes `path-1.ext`, `path-2.ext`, …), returning " +
        "`{ paths, segments, ... }` — `path` is required for that fallback.",
      inputSchema: screenshotOptionsSchema,
      handler: async (
        input,
        driver
      ): Promise<
        ScreenshotResult | ScreenshotFileResult | ScreenshotSegmentsResult
      > => {
        const opts = screenshotOptionsSchema.parse(input)
        if (
          opts.fullPage &&
          !opts.selector &&
          !driver.capabilities.canFullPageScreenshot
        ) {
          if (!opts.path) {
            throw new Error(
              "browser_screenshot: this driver has no native full-page capture " +
                "(Gecko/Camofox) — pass `path` so it can split the page into " +
                "per-viewport segment files instead."
            )
          }
          if (!options.writeArtifact) {
            throw new Error(
              "browser_screenshot: `path` requires a host artifact writer; " +
                "this driver returns base64 only."
            )
          }
          return captureFullPageAsSegments(
            driver,
            { ...opts, path: opts.path },
            options.writeArtifact
          )
        }
        const shot = await driver.screenshot(opts)
        if (!opts.path) return shot
        if (!options.writeArtifact) {
          throw new Error(
            "browser_screenshot: `path` requires a host artifact writer; " +
              "this driver returns base64 only."
          )
        }
        const bytes = Buffer.from(shot.base64, "base64")
        const path = options.writeArtifact(opts.path, bytes)
        return {
          path,
          format: shot.format,
          bytes: bytes.length,
          width: shot.width,
          height: shot.height,
        }
      },
    },
    {
      name: "browser_get_dom",
      description:
        "Return serialized DOM (outerHTML) of the page or a selector. Pass " +
        "`path` to write it to a file and get back its path instead of the " +
        "raw HTML (strongly preferred for large pages, so the bytes don't " +
        "bloat the response).",
      inputSchema: getDomInputSchema,
      handler: async (input, driver) => {
        const opts = getDomInputSchema.parse(input)
        const html = await driver.getDom(opts.selector)
        if (!opts.path) return { html }
        if (!options.writeArtifact) {
          throw new Error(
            "browser_get_dom: `path` requires a host artifact writer; " +
              "this driver returns inline HTML only."
          )
        }
        const bytes = Buffer.from(html, "utf-8")
        const path = options.writeArtifact(opts.path, bytes)
        return { path, bytes: bytes.length }
      },
    },
    {
      name: "browser_list_requests",
      description:
        "List recent network requests captured by the driver's ring buffer.",
      inputSchema: listRequestsInputSchema,
      handler: async (
        input,
        driver
      ): Promise<{ requests: NetworkRequestSummary[] }> => {
        const opts = listRequestsInputSchema.parse(input)
        return { requests: await driver.listRequests(opts) }
      },
    },
    {
      name: "browser_get_request_body",
      description:
        "Fetch a captured response body by requestId. Requires response-body capability.",
      inputSchema: getRequestBodyInputSchema,
      handler: async (input, driver) => {
        const opts = getRequestBodyInputSchema.parse(input)
        return driver.getRequestBody(opts.requestId)
      },
    },
    {
      name: "browser_cdp_send",
      description:
        "Send a raw Chrome DevTools Protocol command. Escape hatch for ops not covered by other tools.",
      inputSchema: cdpSendInputSchema,
      handler: async (input, driver) => {
        const opts = cdpSendInputSchema.parse(input)
        return driver.send({ method: opts.method, params: opts.params })
      },
    },
  ]
}

/**
 * Provider-level tool catalog — see {@link BrowserProviderMcpTool}.
 *
 * These tools take the `BrowserDriverProvider` (kept across attaches)
 * instead of a single-tab `BrowserDriver`. The extension MCP server
 * dispatches the right catalog by tool name.
 */
export function createBrowserProviderMcpTools(): BrowserProviderMcpTool[] {
  return [
    {
      name: "browser_list_tabs",
      description:
        "List all open tabs in the user's browser. Returns each tab's id, " +
        "URL, and title. Use the returned id with `browser_focus_tab` to " +
        "switch the driver's attached tab.",
      inputSchema: z.object({}).loose(),
      handler: async (
        _input,
        provider
      ): Promise<{ tabs: BrowserTarget[] }> => ({
        tabs: await provider.listTargets(),
      }),
    },
    {
      name: "browser_focus_tab",
      description:
        "Switch the driver's attached tab to a specific tab id (from " +
        "browser_list_tabs or browser_open_tab). Subsequent " +
        "browser_navigate / click / fill / screenshot calls operate on " +
        "this tab. Closes any prior attach cleanly so the previous tab " +
        "is released back to the user (no lingering DevTools-style " +
        "banner once detached).",
      inputSchema: z
        .object({
          tabId: z
            .string()
            .min(1)
            .describe(
              "Tab id from browser_list_tabs or browser_open_tab. " +
                "Numeric string in the extension backend; arbitrary id " +
                "string in headless."
            ),
        })
        .loose(),
      handler: async (input, provider): Promise<{ tab: BrowserTarget }> => {
        const opts = z.object({ tabId: z.string().min(1) }).parse(input)
        // Provider may implement `focusTab` natively (extension caches
        // the new tabId for future attach() calls without an immediate
        // chrome.debugger reattach — defer the attach until the agent
        // actually runs a tab-scoped command, so we don't burn the
        // DevTools slot prematurely). Fall back to a plain attach when
        // absent — headless treats the tab id as the target id.
        if (typeof provider.focusTab === "function") {
          return { tab: await provider.focusTab(opts.tabId) }
        }
        const driver = await provider.attach({ targetId: opts.tabId })
        const target = driver.target
        await driver.close().catch(() => undefined)
        return { tab: target }
      },
    },
    {
      name: "browser_open_tab",
      description:
        "Open a new tab in the user's browser, optionally pre-navigating " +
        "to a URL. Returns the new tab's id — pass it as `target` to " +
        "subsequent browser_* calls (or use `browser_focus_tab` to make " +
        "it the default driver target). Preferred over driving the " +
        "user's existing tabs: keeps automation isolated, doesn't fight " +
        "DevTools sessions the user has open on their working tabs.",
      inputSchema: z
        .object({
          url: z
            .string()
            .url()
            .optional()
            .describe(
              "Initial URL. Omit to open about:blank — useful when the " +
                "agent wants to fill the tab via subsequent navigate calls."
            ),
          active: z
            .boolean()
            .default(false)
            .describe(
              "Whether to focus the new tab visually. Default false so " +
                "the agent doesn't yank focus away from the user."
            ),
        })
        .loose(),
      handler: async (input, provider): Promise<{ tab: BrowserTarget }> => {
        const opts = z
          .object({
            url: z.string().url().optional(),
            active: z.boolean().default(false),
          })
          .parse(input)
        // Provider may implement `openTab` natively (extension via
        // chrome.tabs.create; headless via context.newPage). If absent,
        // fall back to attach({initialUrl}) — works for headless where
        // attach creates the page.
        if (typeof provider.openTab === "function") {
          return { tab: await provider.openTab(opts) }
        }
        // Headless fallback — attach creates a fresh page when no
        // targetId is provided. Close the driver immediately; the
        // caller will re-attach via the standard tool path.
        const driver = await provider.attach({
          ...(opts.url ? { initialUrl: opts.url } : {}),
        })
        const target = driver.target
        await driver.close().catch(() => undefined)
        return { tab: target }
      },
    },
  ]
}

/**
 * Convert the Zod-based catalog into MCP `tools/list`-shaped descriptors. Uses
 * Zod 4's built-in JSON-Schema conversion so we don't carry a separate dep.
 *
 * Accepts both tab- and provider-level tools — they share the descriptor
 * shape, only their handler signatures differ.
 */
export function toMcpToolDescriptors(
  tools: ReadonlyArray<BrowserMcpTool | BrowserProviderMcpTool>
): Array<{
  name: string
  description: string
  inputSchema: unknown
}> {
  return tools.map(t => ({
    name: t.name,
    description: t.description,
    // INPUT view: a `.default()` field is advertised optional (its absence is
    // filled at parse time), not `required` as the output view would mark it.
    inputSchema: z.toJSONSchema(t.inputSchema, { io: "input" }),
  }))
}
