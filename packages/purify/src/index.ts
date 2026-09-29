/**
 * @agentproto/bureau-purify — turn raw fetched HTML into clean reading
 * material, deterministically.
 *
 * Fetching (HTTP / Chromium / Camofox / agent) and purifying (boilerplate
 * stripping → main article as Markdown) are separate concerns: the scrape
 * router returns HTML; this turns that HTML into `{ title, markdown }`.
 * Keeping it a standalone package lets the browser project stay pure —
 * Defuddle is a plain dependency, so nothing here couples to an app
 * integration layer. The agentik `integration-content` package re-exports
 * this as its single source of truth instead of wrapping Defuddle twice.
 *
 * Deterministic and dependency-light: no LLM, no network, no DOM globals
 * beyond what `defuddle/node` provides for itself.
 */

import { Defuddle } from "defuddle/node"

export interface PurifyResult {
  /** The article/page title Defuddle resolved (may be empty). */
  readonly title: string
  /** The main content as Markdown, boilerplate stripped. */
  readonly markdown: string
}

/**
 * Purify a fetched HTML document into `{ title, markdown }`.
 *
 * Defuddle's `markdown` option defaults to false, so we pin it true — the
 * whole point here is clean reading material. (Defuddle has no link/image
 * toggles in 0.14, so there are no extraction knobs to surface.)
 *
 * @param html  The raw HTML (as fetched — full page, nav/ads and all).
 * @param url   The source URL — Defuddle uses it to resolve relative links.
 * @throws if `html` is empty or Defuddle cannot parse the document; the
 *   caller decides whether an unparseable page is a skip or a hard error.
 */
export async function purify(html: string, url: string): Promise<PurifyResult> {
  if (!html.trim()) throw new Error("purify: html is empty")
  const result = await Defuddle(html, url, { markdown: true })
  return {
    title: (result.title ?? "").trim(),
    markdown: (result.content ?? "").trim(),
  }
}
