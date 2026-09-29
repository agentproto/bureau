/**
 * Scrape tool entry: stealth browser read. Navigate to a URL (optionally as a
 * saved logged-in identity) and return the page title + readable text. Composed
 * from the control catalogue's raw navigate + evaluate handlers so it reuses
 * the same anonymous camofox tab rather than opening a new one.
 */

import { z } from "zod"
import type { BrowserMcpToolDescriptor } from "@agentproto/bureau-mcp"
import { asContent, toInputSchema, type McpEntry } from "../mcp-tool.js"
import { sessionResolver, type BureauSessionDeps } from "./sessions.js"

/**
 * In-page probe for images the text extraction drops: the og:image (on a
 * logged-in social profile this IS the display photo) plus any
 * profile-displayphoto/framedphoto srcs. Returns a JSON string so it survives
 * the string-typed evaluate bridge. Used only when scrape is called with
 * `images: true` (opt-in — the default read stays text-only + cheap).
 */
const IMAGES_EXPR =
  "JSON.stringify((function(){" +
  "var og=(document.querySelector('meta[property=\"og:image\"]')||{}).content||null;" +
  "var imgs=[].slice.call(document.querySelectorAll('img')).map(function(i){return i.currentSrc||i.src;})" +
  ".filter(function(s){return s&&/media\\.licdn\\.com\\/.*(profile-displayphoto|profile-framedphoto)/.test(s);});" +
  "var uniq=imgs.filter(function(s,i){return imgs.indexOf(s)===i;}).slice(0,4);" +
  "return {og:og,images:uniq};" +
  "})())"

/** Pick the best photo URL from the probe: a display-photo og:image, else the first display-photo img, else og. */
function pickPhoto(probe: {
  og: string | null
  images: string[]
}): string | null {
  const isDisplay = (s: string) =>
    /profile-displayphoto|profile-framedphoto/.test(s)
  if (probe.og && isDisplay(probe.og)) return probe.og
  const img = probe.images.find(isDisplay) ?? probe.images[0]
  return img ?? probe.og ?? null
}

function parseProbe(raw: string | undefined): {
  og: string | null
  images: string[]
} {
  if (!raw) return { og: null, images: [] }
  try {
    const p: unknown = JSON.parse(raw)
    if (p && typeof p === "object") {
      const o = p as { og?: unknown; images?: unknown }
      return {
        og: typeof o.og === "string" ? o.og : null,
        images: Array.isArray(o.images)
          ? o.images.filter((s): s is string => typeof s === "string")
          : [],
      }
    }
  } catch {
    /* fall through */
  }
  return { og: null, images: [] }
}

export function createScrapeEntries(deps: {
  ctlByName: Map<string, BrowserMcpToolDescriptor>
  sessionDeps: BureauSessionDeps
}): McpEntry[] {
  const { ctlByName, sessionDeps } = deps

  const navigateTool = ctlByName.get("browser_navigate")
  const evaluateTool = ctlByName.get("browser_evaluate")

  const scrapeEntry: McpEntry = {
    name: "scrape",
    description:
      "Navigate the stealth (camofox) browser to a URL and return the page's " +
      "title and readable text. Use for pages a plain HTTP fetch can't read — " +
      "JS-rendered, logged-in, or bot-walled. Pass `session` (a saved logged-in " +
      "identity) to read a page behind a login (e.g. your LinkedIn feed); " +
      "without it the read is anonymous. Returns { url, title, text }; with " +
      "`images: true` also returns { image, images } — the og:image (the " +
      "profile display photo on a logged-in social profile) and any " +
      "profile-displayphoto srcs the text extraction drops.",
    jsonSchema: toInputSchema(
      z.object({
        url: z.string().describe("Absolute URL to load."),
        session: z
          .string()
          .optional()
          .describe(
            "Saved session id to drive (logged-in identity). Omit for anonymous."
          ),
        waitUntil: z
          .enum(["load", "domcontentloaded", "networkidle"])
          .optional()
          .describe("Navigation completion signal (default load)."),
        maxBytes: z
          .number()
          .optional()
          .describe("Cap on returned text bytes (default 200000)."),
        images: z
          .boolean()
          .optional()
          .describe(
            "Also extract the og:image + profile-displayphoto srcs (the display " +
              "photo the text read strips). Returns `image` (best URL) + `images`."
          ),
      })
    ),
    call: async args => {
      const url = String((args as { url?: unknown }).url ?? "")
      if (!url) throw new Error("scrape: `url` is required")
      const maxBytes =
        Number((args as { maxBytes?: number }).maxBytes) || 200_000
      const sessionArg = (args as { session?: unknown }).session
      const sessionId =
        typeof sessionArg === "string" && sessionArg ? sessionArg : undefined
      const wantImages = Boolean((args as { images?: unknown }).images)

      // Logged-in read: drive the saved session rather than the anonymous
      // driver context. Fresh resolve per call (read-only — no page state to
      // preserve across calls). The session's own navigate/evaluate back the
      // same title + readable-text extraction.
      if (sessionId) {
        const human = await sessionResolver(sessionDeps).resolve(sessionId)
        await human.navigate(url)
        const title = (await human.evaluate<string>("document.title")) ?? ""
        const raw =
          (await human.evaluate<string>(
            "document.body ? document.body.innerText : ''"
          )) ?? ""
        const truncated = raw.length > maxBytes
        const probe = wantImages
          ? parseProbe(await human.evaluate<string>(IMAGES_EXPR))
          : { og: null, images: [] }
        return asContent({
          url,
          title,
          text: truncated ? raw.slice(0, maxBytes) : raw,
          truncated,
          ...(wantImages
            ? { image: pickPhoto(probe), images: probe.images }
            : {}),
        })
      }

      if (!navigateTool || !evaluateTool) {
        throw new Error("scrape: control catalogue missing navigate/evaluate")
      }
      const waitUntil = (args as { waitUntil?: string }).waitUntil ?? "load"
      await navigateTool.handler({ url, waitUntil })
      const titleRes = (await evaluateTool.handler({
        expression: "document.title",
        returnByValue: true,
        awaitPromise: true,
      })) as { value?: unknown }
      const textRes = (await evaluateTool.handler({
        expression: "document.body ? document.body.innerText : ''",
        returnByValue: true,
        awaitPromise: true,
        maxResultBytes: maxBytes,
      })) as { value?: unknown; truncated?: boolean }
      let probe = { og: null as string | null, images: [] as string[] }
      if (wantImages) {
        const imgRes = (await evaluateTool.handler({
          expression: IMAGES_EXPR,
          returnByValue: true,
          awaitPromise: true,
        })) as { value?: unknown }
        probe = parseProbe(
          typeof imgRes.value === "string" ? imgRes.value : undefined
        )
      }
      return asContent({
        url,
        title: typeof titleRes.value === "string" ? titleRes.value : "",
        text: typeof textRes.value === "string" ? textRes.value : "",
        truncated: Boolean(textRes.truncated),
        ...(wantImages
          ? { image: pickPhoto(probe), images: probe.images }
          : {}),
      })
    },
  }

  return [scrapeEntry]
}
