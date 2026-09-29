/**
 * Core-owned capability ports. Structurally identical to the shapes the private
 * action packages use, so a plugin's implementations satisfy them without core
 * importing those packages.
 */

import type { SessionDescriptor } from "@agentproto/browser-profiles"
import type { HumanSession } from "@agentproto/bureau-core/page-eval"

export type { HumanSession, SessionDescriptor }

/** A saved descriptor's id, or an inline descriptor to resolve on the fly. */
export type SessionRef = string | SessionDescriptor

/** Resolves a {@link SessionRef} into a live {@link HumanSession}. */
export interface SessionResolver {
  resolve(ref: SessionRef): Promise<HumanSession>
}

/** Read-only secret/key accessor. */
export interface KeyVault {
  get(name: string): string | undefined
}

/** Outbound delivery port (a concrete channel abstracted). */
export interface ChannelPort {
  send(message: {
    to: string
    text?: string
    image?: string
    document?: string
    caption?: string
  }): Promise<{ id?: string }>
}

/** Stateless structured-output model seam. */
export interface ModelPort {
  complete(req: {
    system?: string
    prompt: string
    images?: string[]
    schema?: unknown
    temperature?: number
  }): Promise<{
    result: unknown
    usage?: { inputTokens?: number; outputTokens?: number }
  }>
}

/** Remote-compute seam for server-enforced recipes. */
export interface SynthesizePort {
  synthesize(sources: Array<{ path: string; content: string }>): Promise<{
    entries: Array<{ path: string; content: string }>
    distilled: number
    skipped: number
  }>
}
