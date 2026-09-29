/** Adapt a warm camofox session to the `HumanSession` verbs the capture/workflow layer speaks. */

import {
  openSession,
  type CamofoxSession,
  type OpenSessionOptions,
} from "@agentproto/browser-profiles"
import { BLOCKED_PAGE_EXPRESSION } from "@agentproto/bureau-drivers/camofox"
import type { HumanSession } from "@agentproto/bureau-core/page-eval"
import { platformKit } from "./platform-kit.js"

/** An anti-bot wall surfaced while navigating; a handler may notify a human and wait. */
export interface ChallengeInfo {
  site: string
  url: string
  reason: string
  screenshot?: { bytes: Uint8Array; mime: string }
  /** True while the page is STILL blocked. */
  recheck: () => Promise<boolean>
}

export interface HumanOpenOptions extends OpenSessionOptions {
  onChallenge?: (info: ChallengeInfo) => Promise<"cleared" | "give-up">
}

/** A camofox tab plus the human-paced verbs the capture layer speaks. */
export type HumanCamofoxSession = CamofoxSession & {
  gotoPaced(url: string): Promise<void>
  scroll(times?: number): Promise<void>
  acceptConsent(selectors: string[]): Promise<boolean>
  isBlocked(): Promise<boolean>
  readNextData<T = unknown>(extractor: string): Promise<T>
}

/** The slice of a warm camofox session a {@link HumanSession} adapts over. */
export interface CamofoxSessionLike {
  goto(url: string, waitUntil?: string): Promise<void>
  evaluate<T = unknown>(expression: string): Promise<T>
  gotoPaced(url: string): Promise<void>
  scroll(times?: number): Promise<void>
  acceptConsent(selectors: string[]): Promise<boolean>
  type(selector: string, text: string, opts?: { delay?: number }): Promise<void>
  click(selector: string): Promise<void>
  press(key: string): Promise<void>
  isBlocked(): Promise<boolean>
  readNextData<T = unknown>(extractor: string): Promise<T>
  screenshot?(opts?: {
    format?: "png" | "jpeg"
    quality?: number
  }): Promise<{ imageBase64: string; mimeType: string }>
}

/** `navigate`/`evaluate` map onto `goto`/`evaluate`; every other verb passes through. */
export function fromCamofoxSession(s: CamofoxSessionLike): HumanSession {
  return {
    navigate: url => s.goto(url),
    evaluate: <T>(expression: string) => s.evaluate<T>(expression),
    gotoPaced: url => s.gotoPaced(url),
    scroll: times => s.scroll(times),
    acceptConsent: selectors => s.acceptConsent(selectors),
    type: (selector, text, opts) => s.type(selector, text, opts),
    click: selector => s.click(selector),
    press: key => s.press(key),
    isBlocked: () => s.isBlocked(),
    readNextData: <T>(extractor: string) => s.readNextData<T>(extractor),
    ...(s.screenshot ? { screenshot: o => s.screenshot!(o) } : {}),
  }
}

/** Thrown (as the message prefix) by `gotoPaced` when an anti-bot wall is hit. */
export const BLOCKED_PREFIX = "DATADOME_BLOCK"

export const isBlockedError = (e: unknown): boolean =>
  e instanceof Error && e.message.startsWith(BLOCKED_PREFIX)

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

const hostOf = (u: string): string => {
  try {
    return new URL(u).hostname.replace(/^www\./, "")
  } catch {
    return u
  }
}

/** Add generic human-paced verbs (short dwells, plain scrolling) to a base camofox tab. */
export function withHumanVerbs(
  base: CamofoxSession,
  onChallenge?: HumanOpenOptions["onChallenge"]
): HumanCamofoxSession {
  const isBlocked = (): Promise<boolean> =>
    base.evaluate<boolean>(BLOCKED_PAGE_EXPRESSION)
  return Object.assign(base, {
    isBlocked,
    async gotoPaced(url: string): Promise<void> {
      await base.goto(url)
      await sleep(500 + (Date.now() % 900))
      if (!(await isBlocked())) return
      if (onChallenge) {
        let screenshot: ChallengeInfo["screenshot"]
        try {
          const shot = await base.screenshot({ format: "png" })
          screenshot = {
            bytes: Buffer.from(shot.imageBase64, "base64"),
            mime: shot.mimeType,
          }
        } catch {
          // no screenshot: the handler still gets text
        }
        const outcome = await onChallenge({
          site: hostOf(url),
          url,
          reason: "anti-bot wall",
          ...(screenshot ? { screenshot } : {}),
          recheck: isBlocked,
        })
        if (outcome === "cleared" && !(await isBlocked())) return
      }
      throw new Error(`${BLOCKED_PREFIX}: anti-bot wall on ${url}`)
    },
    async scroll(times = 3): Promise<void> {
      for (let i = 0; i < times; i++) {
        await base.evaluate(`window.scrollBy(0, ${240 + (Date.now() % 420)})`)
        await sleep(500 + (Date.now() % 900))
      }
    },
    async acceptConsent(selectors: string[]): Promise<boolean> {
      for (const sel of selectors) {
        const present = await base
          .evaluate<boolean>(`!!document.querySelector(${JSON.stringify(sel)})`)
          .catch(() => false)
        if (present) {
          await base.click(sel).catch(() => {})
          await sleep(500)
          return true
        }
      }
      return false
    },
    readNextData<T = unknown>(extractor: string): Promise<T> {
      return base.evaluate<T>(`(() => { try {
      const d = JSON.parse(document.getElementById("__NEXT_DATA__").textContent);
      return (${extractor})(d);
    } catch (e) { return null } })()`)
    },
  })
}

/**
 * Open a camofox tab with human-paced verbs. A plugin's platform kit may
 * supply a richer opener (challenge handling, pacing); otherwise the generic
 * one above is used.
 */
export async function openHumanSession(
  opts: HumanOpenOptions
): Promise<HumanCamofoxSession> {
  const custom = platformKit().openHumanSession
  if (custom) return custom(opts)
  const { onChallenge, ...rest } = opts
  return withHumanVerbs(await openSession(rest), onChallenge)
}
