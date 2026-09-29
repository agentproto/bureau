/**
 * Claude-backed vision model for the element resolver's L4 (set-of-marks) tier.
 *
 * A thin `fetch` adapter over the Anthropic Messages API — no SDK dependency, so
 * Bureau stays lean. It's handed a screenshot whose interactive elements are
 * already boxed and numbered (drawn by `makeVisionResolver`), plus the candidate
 * list, and is asked for a single uid. We cap output to a few tokens and parse the
 * first integer: the model's whole job is to name a box, not to chat.
 *
 * This is one implementation of `KitVisionModel`; a self-hosted agentproto vision
 * overlay is another, and drops in at the same seam without touching the resolver.
 */

import type { KitVisionModel } from "./platform-kit.js"

export interface ClaudeVisionOptions {
  /** Defaults to ANTHROPIC_API_KEY. Absent → the model declines (returns null). */
  apiKey?: string
  /** A vision-capable model id. */
  model?: string
  /** Override the Messages endpoint (tests / proxies). */
  endpoint?: string
}

const DEFAULT_MODEL = "claude-opus-4-8"
const DEFAULT_ENDPOINT = "https://api.anthropic.com/v1/messages"

export function claudeVisionModel(opts: ClaudeVisionOptions = {}): KitVisionModel {
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY
  const model = opts.model ?? DEFAULT_MODEL
  const endpoint = opts.endpoint ?? DEFAULT_ENDPOINT

  return {
    async choose({ description, elements, imageBase64, mimeType }) {
      if (!apiKey) return null
      const catalogue = elements
        .map(
          e =>
            `${e.uid}: <${e.role}${e.type ? ` type=${e.type}` : ""}> ${e.name || "(no label)"}`
        )
        .join("\n")
      const prompt =
        `The screenshot shows a web page with numbered red boxes over interactive ` +
        `elements. Pick the box that is ${description}.\n\n` +
        `Boxes (uid: element):\n${catalogue}\n\n` +
        `Reply with ONLY the uid number of the best match, or -1 if none fits.`

      let res: Response
      try {
        res = await fetch(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model,
            max_tokens: 16,
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "image",
                    source: { type: "base64", media_type: mimeType, data: imageBase64 },
                  },
                  { type: "text", text: prompt },
                ],
              },
            ],
          }),
        })
      } catch {
        return null // network error — let the caller fall through to the human
      }
      if (!res.ok) return null
      const body = (await res.json()) as { content?: Array<{ text?: string }> }
      const text = body.content?.[0]?.text ?? ""
      const m = text.match(/-?\d+/)
      if (!m) return null
      const uid = Number.parseInt(m[0], 10)
      return uid >= 0 ? uid : null
    },
  }
}
