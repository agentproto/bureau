/**
 * Pairing is the only auth in the OSS Bureau (AIP-59). This module wires
 * `@agentproto/pairing-host` to Bureau:
 *
 *   - local MCP hosts hold a device bearer (`bureau install-mcp`) that
 *     `authorize` checks with `verifyDeviceBearer`;
 *   - remote devices pair over the E2E rendezvous and reach `/mcp` through
 *     `serveLoopbackHttp`, which forwards to the local server with a
 *     per-process in-memory gateway credential. The peer's own `Authorization`
 *     is overwritten by the injected one, so it never reaches the target; the
 *     paired device's fingerprint rides in a header that `authorize` trusts
 *     only when it arrives with that credential.
 *
 * There is no static token, no env var and no file that holds a shared secret.
 */

import { randomBytes, timingSafeEqual, createHash } from "node:crypto"
import type { IncomingMessage } from "node:http"
import { homedir } from "node:os"
import { join } from "node:path"
import type { FrameSink } from "@agentproto/acp/tunnel"
import {
  createPairingRegistry,
  dialRendezvous,
  serveLoopbackHttp,
  type PairingHostRegistry,
  type PairingRecord,
} from "@agentproto/pairing-host"
import { generateIdentity, loadOrCreateIdentity } from "@agentproto/secrets/identity"
import type { Authorize } from "./mcp-server.js"

/** Header the gateway sets to tell `authorize` which paired device a forwarded request came from. */
export const PAIRED_DEVICE_HEADER = "x-bureau-paired-device"

/** The only paths a remote paired peer may request. */
export const REMOTE_ALLOW_PATHS: readonly string[] = ["/mcp", "/health", "/live/*"]

/** Bureau's state dir: pairings, identity, grants, control socket. `BUREAU_HOME` overrides (tests, multi-instance). */
export function bureauHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.BUREAU_HOME?.trim()
  return override ? override : join(homedir(), ".agentproto", "bureau")
}

export const pairingsPathIn = (home: string): string => join(home, "pairings.json")
export const identityPathIn = (home: string): string => join(home, "identity.json")

export interface BureauPairingOptions {
  home?: string
  /** Port of the local Bureau `/mcp` server that remote channels forward to. */
  port: number
  /** Rendezvous override; unset falls back to the hosted default (which `createOffer` flags). */
  rendezvousUrl?: string
  /** Dial override (tests use an in-memory rendezvous). */
  dial?: (url: string, signal: AbortSignal) => Promise<FrameSink>
  /** Ephemeral identity instead of `identity.json` (tests). */
  ephemeralIdentity?: boolean
  log?: (line: string) => void
}

export interface BureauPairing {
  registry: PairingHostRegistry
  authorize: Authorize
  home: string
}

const sha = (s: string): Buffer => createHash("sha256").update(s).digest()

function bearerOf(req: IncomingMessage): string | undefined {
  const raw = req.headers.authorization
  if (typeof raw !== "string") return undefined
  const m = /^Bearer\s+(\S+)$/i.exec(raw.trim())
  return m?.[1]
}

/** Build the pairing registry and the `authorize` that reads it. Nothing is
 *  dialed or written until a pairing is created or autoconnect starts. */
export function createBureauPairing(opts: BureauPairingOptions): BureauPairing {
  const home = opts.home ?? bureauHome()
  const log = opts.log ?? (() => {})
  const target = new URL(`http://127.0.0.1:${opts.port}`)
  const gatewaySecret = randomBytes(32).toString("base64url")
  const gatewayDigest = sha(gatewaySecret)

  let ephemeral: ReturnType<typeof generateIdentity> | undefined
  const registry = createPairingRegistry({
    loadIdentity: () => {
      if (!opts.ephemeralIdentity) return loadOrCreateIdentity(identityPathIn(home))
      ephemeral ??= generateIdentity()
      return ephemeral
    },
    pairingsPath: pairingsPathIn(home),
    ...(opts.rendezvousUrl !== undefined ? { defaultRendezvousUrl: opts.rendezvousUrl } : {}),
    dial: opts.dial ?? ((url, signal) => dialRendezvous(url, signal)),
    serve: (sink, ctx) =>
      serveLoopbackHttp({
        target,
        allowPaths: REMOTE_ALLOW_PATHS,
        injectHeaders: {
          authorization: `Bearer ${gatewaySecret}`,
          [PAIRED_DEVICE_HEADER]: ctx.fingerprint,
        },
        label: "bureau",
      })(sink, ctx),
    log,
  })

  const authorize: Authorize = async req => {
    const bearer = bearerOf(req)
    if (!bearer) return false

    if (timingSafeEqual(sha(bearer), gatewayDigest)) {
      const claimed = req.headers[PAIRED_DEVICE_HEADER]
      const fingerprint = typeof claimed === "string" ? claimed : undefined
      if (!fingerprint) return false
      const live = (await registry.list()).find(
        r => r.fingerprint === fingerprint && !r.local && r.legacy !== true
      )
      return live
        ? { ok: true, device: { fingerprint, name: live.name, remote: true } }
        : false
    }

    const device = await registry.verifyDeviceBearer(bearer)
    return device
      ? { ok: true, device: { fingerprint: device.fingerprint, name: device.name } }
      : false
  }

  return { registry, authorize, home }
}

/** A registry that only reads and edits `pairings.json` (no rendezvous, no identity). For `devices list|revoke`
 *  when no server is running, and for `install-mcp`. A local device's revoke is honoured by a running server on its next request. */
export function createOfflineRegistry(home: string = bureauHome()): PairingHostRegistry {
  return createPairingRegistry({
    loadIdentity: () => Promise.reject(new Error("bureau: this command does not pair remote devices")),
    pairingsPath: pairingsPathIn(home),
    dial: () => Promise.reject(new Error("bureau: offline registry does not dial")),
    serve: () => {
      throw new Error("bureau: offline registry does not serve")
    },
  })
}

/** A device as shown to a human: never the pair root, client key or any secret. */
export interface DeviceSummary {
  fingerprint: string
  name: string
  kind: "local" | "remote"
  createdAt: string
  lastSeen?: string
  legacy?: boolean
}

export function summarizeDevice(r: PairingRecord): DeviceSummary {
  return {
    fingerprint: r.fingerprint,
    name: r.name,
    kind: r.local ? "local" : "remote",
    createdAt: r.createdAt,
    ...(r.local ? {} : { lastSeen: r.lastSeen }),
    ...(r.legacy ? { legacy: true } : {}),
  }
}
