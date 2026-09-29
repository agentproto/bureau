/**
 * Re-auth notifier — the PUSH half of the re-auth fork (the CLI print lives in
 * reauth.ts). Bureau depends on the NotifierPort; the channel is chosen at the
 * composition root:
 *   - built in: a direct message to you (WhatsApp text, env-driven)
 *   - plugins: extra channels via {@link registerNotifierFactory}
 *
 * The WhatsApp transport is the connect-free one-shot sender shared across the
 * Bureau library (@agentproto/bureau-core/notify), not a connecting provider
 * that would hang a fire-and-forget CLI alert.
 */

import {
  sendWhatsAppText,
  sendWhatsAppImage,
} from "@agentproto/bureau-core/notify"

/** A saved session hit a login wall and needs re-authentication. */
export interface ReauthEvent {
  kind: "session-expired"
  /** The saved session id that hit the wall. */
  session: string
  /** The platform it expired on (x | linkedin | …). */
  platform: string
  /** The exact command that re-establishes the session. */
  loginCommand: string
}

/** An anti-bot wall (DataDome captcha / slider) is blocking a run and needs a
 *  human to solve it in the visible (headful) window. */
export interface ChallengeEvent {
  kind: "challenge"
  /** The site whose wall is up (e.g. "leboncoin.fr"). */
  site: string
  /** The URL that tripped the wall. */
  url: string
  /** Why it surfaced (e.g. "anti-bot / DataDome wall"). */
  reason: string
  /** The command that re-opens the solve window, if the human dismissed it. */
  solveCommand?: string
  /** A screenshot of the challenge to show inline (PNG/JPEG bytes). */
  screenshot?: { bytes: Uint8Array; mime: string }
}

/** Anything the notifier delivers — a human-action event over a swappable
 *  channel. New event kinds slot in here; each channel formats what it can. */
export type NotifierEvent = ReauthEvent | ChallengeEvent

export interface NotifierPort {
  /** Deliver a human-action event. Best-effort: never throws (a failed
   *  notification must not break the run it reports on). */
  notify(event: NotifierEvent): Promise<void>
}

/** No channel configured — the CLI print is the only surface. */
const NULL_NOTIFIER: NotifierPort = { async notify() {} }

function env(name: string): string | undefined {
  const v = process.env[name]
  return v && v.trim() ? v.trim() : undefined
}

/** One-shot WhatsApp over the shared connect-free Cloud API sender. A challenge
 *  also pushes the slider screenshot inline so you can see what to solve. */
function whatsappTextNotifier(to: string): NotifierPort {
  return {
    async notify(event) {
      const phoneNumberId = env("WHATSAPP_PHONE_NUMBER_ID")
      const accessToken = env("WHATSAPP_ACCESS_TOKEN")
      if (!phoneNumberId || !accessToken) return
      const creds = {
        phoneNumberId,
        accessToken,
        apiVersion: env("WHATSAPP_API_VERSION"),
      }
      // Best-effort: a failed alert must never break the run it reports on.
      try {
        if (event.kind === "challenge") {
          const caption =
            `🧩 Bureau — ${event.site} put up an anti-bot wall ` +
            `(${event.reason}). Solve it in the open window.` +
            (event.solveCommand ? `\n→ reopen: ${event.solveCommand}` : "")
          if (event.screenshot)
            await sendWhatsAppImage(creds, to, {
              bytes: event.screenshot.bytes,
              mime: event.screenshot.mime,
              caption,
            })
          else await sendWhatsAppText(creds, to, caption)
          return
        }
        const body =
          `🔐 Bureau — your "${event.session}" session on ${event.platform} ` +
          `needs re-auth (login wall).\n→ ${event.loginCommand}`
        await sendWhatsAppText(creds, to, body)
      } catch (e) {
        console.error(
          `[notifier] whatsapp send failed: ${e instanceof Error ? e.message : String(e)}`
        )
      }
    },
  }
}

/** Extra channels a plugin contributes (e.g. an in-app notification system). */
const notifierFactories = new Map<string, () => NotifierPort | undefined>()

/** Register (or replace, by name) a notifier factory; it returns undefined when unconfigured. */
export function registerNotifierFactory(
  name: string,
  factory: () => NotifierPort | undefined
): void {
  notifierFactories.set(name, factory)
}

/** Drop every registered factory (tests). */
export function clearNotifierFactories(): void {
  notifierFactories.clear()
}

/** Fan one event to every configured notifier (e.g. guild Bell + WhatsApp). */
function compositeNotifier(notifiers: NotifierPort[]): NotifierPort {
  return {
    async notify(event) {
      await Promise.all(notifiers.map(n => n.notify(event)))
    },
  }
}

/**
 * Resolve the active notifier(s) from env and registered plugin channels,
 * composed (all can fire). The WhatsApp channel (ALERT_CHANNEL=whatsapp +
 * ALERT_TO) pushes you directly. Nothing configured → the null notifier (the
 * CLI re-auth line still prints).
 */
export function resolveNotifier(): NotifierPort {
  const notifiers: NotifierPort[] = []

  for (const factory of notifierFactories.values()) {
    const n = factory()
    if (n) notifiers.push(n)
  }

  const channel = env("ALERT_CHANNEL") ?? "whatsapp"
  const to = env("ALERT_TO") ?? env("WHATSAPP_ALERT_TO")
  if (channel === "whatsapp" && to) notifiers.push(whatsappTextNotifier(to))

  if (notifiers.length === 0) return NULL_NOTIFIER
  if (notifiers.length === 1) return notifiers[0]!
  return compositeNotifier(notifiers)
}
