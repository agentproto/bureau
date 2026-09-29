/**
 * Platform kit: the seam for per-site knowledge (login forms, home URLs,
 * multi-account switching, vision grounding). Core ships no site knowledge;
 * a plugin registers a kit at load time and every core command reads it here.
 * With no kit registered the accessors return neutral values (no known
 * platforms, no login specs), so generic `--url` flows keep working.
 */

import type { AccountSwitcher } from "@agentproto/browser-profiles"
import type { HumanCamofoxSession, HumanOpenOptions } from "./human-session.js"

/** A known site: its cookie origin and, optionally, the authed landing URL. */
export interface KitPlatform {
  readonly domain: string
  readonly home?: string
}

/** How to reach a site's login page. */
export interface KitLoginSpec {
  readonly url: string
  /** True when the site usually raises a 2FA or device prompt after sign-in. */
  readonly expectChallenge?: boolean
}

export interface KitAccount {
  userId: string
  active: boolean
  handle?: string
}

export interface KitElement {
  readonly uid: number
  readonly role: string
  readonly type: string | null
  readonly name: string
}

/** A model that names one numbered box on a screenshot, or null. */
export interface KitVisionModel {
  choose(input: {
    readonly description: string
    readonly elements: ReadonlyArray<KitElement>
    readonly imageBase64: string
    readonly mimeType: string
  }): Promise<number | null>
}

export interface KitVisionResolver {
  pick(input: {
    readonly description: string
    readonly elements: ReadonlyArray<KitElement>
    readonly screenshot?: string
  }): Promise<number | null>
}

/** The slice of a live page the autofill driver and vision resolver use. */
export interface KitSession {
  evaluate<T = unknown>(expression: string): Promise<T>
  type(selector: string, text: string, opts?: { delay?: number }): Promise<void>
  click(selector: string): Promise<void>
  press(key: string): Promise<void>
  screenshot?(opts?: {
    format?: "png" | "jpeg"
    quality?: number
  }): Promise<{ imageBase64: string; mimeType: string } | null>
}

export interface KitCredential {
  readonly account: string
  readonly password: string
}

export interface KitAutofillResult {
  ran: number
  expectChallenge: boolean
}

export interface PlatformKit {
  /** Known sites by platform key. */
  platforms?: Readonly<Record<string, KitPlatform>>
  /** Login form knowledge by platform key. */
  loginSpec?(platform: string): KitLoginSpec | undefined
  loginPlatformKeys?(): string[]
  /** Type a stored credential into the platform's login form. */
  autofill?(
    session: KitSession,
    platform: string,
    cred: KitCredential,
    opts?: { vision?: KitVisionResolver }
  ): Promise<KitAutofillResult>
  /** Sub-account support inside one browser profile. */
  accounts?: {
    supports(platform: string): boolean
    enumerate(
      profile: string,
      platform?: string
    ): Promise<Array<{ platform: string; accounts: KitAccount[] }>>
    switcher: AccountSwitcher
  }
  /** A richer camofox opener (challenge handling, pacing) than the generic one. */
  openHumanSession?(opts: HumanOpenOptions): Promise<HumanCamofoxSession>
  makeVisionResolver?(deps: {
    session: KitSession
    screenshot: () => Promise<{ imageBase64: string; mimeType: string } | null>
    model: KitVisionModel
  }): KitVisionResolver
}

let kit: PlatformKit = {}

/** Install a kit (replaces any previous one). */
export function registerPlatformKit(next: PlatformKit): void {
  kit = next
}

/** Back to the empty kit (tests). */
export function clearPlatformKit(): void {
  kit = {}
}

export function platformKit(): PlatformKit {
  return kit
}

export function knownPlatform(key: string): KitPlatform | undefined {
  return kit.platforms?.[key]
}

export function knownPlatformKeys(): string[] {
  return Object.keys(kit.platforms ?? {})
}

export function loginSpecFor(platform: string): KitLoginSpec | undefined {
  return kit.loginSpec?.(platform)
}

export function loginPlatformKeys(): string[] {
  return kit.loginPlatformKeys?.() ?? []
}

export function supportsMultiAccount(platform: string): boolean {
  return kit.accounts?.supports(platform) ?? false
}

export async function enumerateProfileAccounts(
  profile: string,
  platform?: string
): Promise<Array<{ platform: string; accounts: KitAccount[] }>> {
  return kit.accounts ? kit.accounts.enumerate(profile, platform) : []
}
