/**
 * Control channel between the `bureau pair` / `bureau devices` CLI and the
 * running server. The registry, its rendezvous connections and the paired
 * channels live in the server process, so a pairing offer (and the revoke of a
 * remote pairing, which the registry only sees in its owning process) must be
 * asked of it. A unix socket in the Bureau home (mode 0600) carries one NDJSON
 * request and one NDJSON reply per connection. Nothing here holds a credential.
 */

import { chmod, unlink } from "node:fs/promises"
import { connect, createServer, type Server } from "node:net"
import { join } from "node:path"
import type { PairingHostRegistry } from "@agentproto/pairing-host"
import { summarizeDevice, type DeviceSummary } from "./pairing.js"

export const controlSocketPath = (home: string): string => join(home, "control.sock")

export type ControlRequest =
  | { op: "offer"; rendezvousUrl?: string; ttlMs?: number }
  | { op: "list" }
  | { op: "revoke"; id: string }

export interface OfferInfo {
  url: string
  exp: number
  fingerprint: string
  rendezvousUrl: string
  rendezvousIsHostedDefault: boolean
}

export type ControlReply =
  | { ok: true; offer: OfferInfo }
  | { ok: true; devices: DeviceSummary[] }
  | { ok: true; revoked: boolean }
  | { ok: false; error: string }

function isControlRequest(v: unknown): v is ControlRequest {
  if (!v || typeof v !== "object") return false
  const o = v as Record<string, unknown>
  if (o.op === "list") return true
  if (o.op === "offer") return true
  return o.op === "revoke" && typeof o.id === "string" && o.id.length > 0
}

async function handle(registry: PairingHostRegistry, req: ControlRequest): Promise<ControlReply> {
  switch (req.op) {
    case "offer": {
      const created = await registry.createOffer({
        ...(req.rendezvousUrl ? { rendezvousUrl: req.rendezvousUrl } : {}),
        ...(req.ttlMs ? { ttlMs: req.ttlMs } : {}),
      })
      return {
        ok: true,
        offer: {
          url: created.url,
          exp: created.exp,
          fingerprint: created.fingerprint,
          rendezvousUrl: created.rendezvousUrl,
          rendezvousIsHostedDefault: created.rendezvousIsHostedDefault,
        },
      }
    }
    case "list":
      return { ok: true, devices: (await registry.list()).map(summarizeDevice) }
    case "revoke":
      return { ok: true, revoked: await registry.revoke(req.id) }
  }
}

async function socketInUse(path: string): Promise<boolean> {
  return new Promise(resolve => {
    const s = connect(path)
    s.once("connect", () => {
      s.destroy()
      resolve(true)
    })
    s.once("error", () => resolve(false))
  })
}

export interface ControlServer {
  close(): Promise<void>
}

/** Serve control requests for `registry` on the home's socket. A stale socket
 *  file (no listener) is replaced; a live one means another Bureau owns this home. */
export async function startControlServer(
  home: string,
  registry: PairingHostRegistry,
  log: (line: string) => void = () => {}
): Promise<ControlServer> {
  const path = controlSocketPath(home)
  if (await socketInUse(path)) {
    throw new Error(`another bureau is already serving ${home}`)
  }
  await unlink(path).catch(() => {})

  const server: Server = createServer(socket => {
    let buf = ""
    socket.setEncoding("utf8")
    socket.on("error", () => {})
    socket.on("data", chunk => {
      buf += chunk
      const nl = buf.indexOf("\n")
      if (nl === -1) return
      const line = buf.slice(0, nl)
      buf = ""
      void (async (): Promise<void> => {
        let reply: ControlReply
        try {
          const parsed: unknown = JSON.parse(line)
          reply = isControlRequest(parsed)
            ? await handle(registry, parsed)
            : { ok: false, error: "bad request" }
        } catch (e) {
          reply = { ok: false, error: e instanceof Error ? e.message : String(e) }
        }
        socket.end(`${JSON.stringify(reply)}\n`)
      })()
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(path, resolve)
  })
  await chmod(path, 0o600)
  log(`control socket ${path}`)
  return {
    close: () =>
      new Promise<void>(resolve => {
        server.close(() => {
          void unlink(path).catch(() => {})
          resolve()
        })
      }),
  }
}

/** Ask the running server. `null` when none is listening on this home. */
export function controlRequest(
  home: string,
  req: ControlRequest,
  timeoutMs = 15_000
): Promise<ControlReply | null> {
  return new Promise((resolve, reject) => {
    const socket = connect(controlSocketPath(home))
    let buf = ""
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error("bureau did not answer on its control socket"))
    }, timeoutMs)
    socket.setEncoding("utf8")
    socket.once("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      if (e.code === "ENOENT" || e.code === "ECONNREFUSED") resolve(null)
      else reject(e)
    })
    socket.once("connect", () => socket.write(`${JSON.stringify(req)}\n`))
    socket.on("data", chunk => {
      buf += chunk
    })
    socket.once("end", () => {
      clearTimeout(timer)
      try {
        resolve(JSON.parse(buf.trim()) as ControlReply)
      } catch {
        reject(new Error("bureau sent an unreadable control reply"))
      }
    })
  })
}
