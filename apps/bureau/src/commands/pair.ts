/**
 * `bureau pair` and `bureau devices` — the AIP-59 pairing surface.
 *
 *   bureau pair [--rendezvous <wss-url>] [--ttl <minutes>] [--no-qr]
 *   bureau devices list
 *   bureau devices revoke <fingerprint|name>
 *
 * `pair` asks the running server (over its control socket) for a one-time offer
 * and prints it as a QR and a URL; the pairing itself completes in the server.
 * `devices` reads the same `pairings.json`; a revoke goes through the running
 * server when there is one (it owns the remote pairings' connections) and edits
 * the file directly otherwise.
 */

import { out, parseArgs } from "../lib/args.js"
import { bureauHome, createOfflineRegistry, summarizeDevice, type DeviceSummary } from "../lib/pairing.js"
import { controlRequest, type OfferInfo } from "../lib/pairing-control.js"

const PAIR_USAGE = `bureau pair — pair a remote device with this Bureau

  bureau pair [--rendezvous <wss-url>] [--ttl <minutes>] [--no-qr]

  Needs a running Bureau (bureau start). Prints a one-time offer as a QR code
  and a URL; on the other machine run: agentproto pair accept "<url>"`

const DEVICES_USAGE = `bureau devices — paired devices

  bureau devices list
  bureau devices revoke <fingerprint|name>`

async function qrText(url: string): Promise<string | undefined> {
  try {
    const mod = await import("qrcode-terminal")
    const qr = mod.default ?? mod
    return await new Promise<string>(resolve => {
      qr.generate(url, { small: true }, (text: string) => resolve(text))
    })
  } catch {
    return undefined
  }
}

export function hostedRendezvousWarning(rendezvousUrl: string): string {
  return (
    `Relaying through the hosted rendezvous ${rendezvousUrl}.\n` +
    `  Traffic is end-to-end encrypted, so the relay sees only ciphertext, but it does see\n` +
    `  connection metadata (when and how often a device connects).\n` +
    `  To use your own, pass --rendezvous <wss-url>.`
  )
}

export async function formatOffer(offer: OfferInfo, withQr: boolean): Promise<string> {
  const lines: string[] = []
  const qr = withQr ? await qrText(offer.url) : undefined
  if (qr) lines.push(qr.trimEnd(), "")
  lines.push(`Offer: ${offer.url}`)
  lines.push(`Bureau identity: ${offer.fingerprint} (check it matches on the other machine)`)
  lines.push(`Valid until ${new Date(offer.exp * 1000).toLocaleTimeString()}, one use.`)
  lines.push("")
  lines.push(`On the other machine:  agentproto pair accept "${offer.url}"`)
  lines.push("")
  lines.push(
    offer.rendezvousIsHostedDefault
      ? hostedRendezvousWarning(offer.rendezvousUrl)
      : `Relaying through ${offer.rendezvousUrl}.`
  )
  return lines.join("\n")
}

export async function runPair(argv: string[], home: string = bureauHome()): Promise<number> {
  const { flags } = parseArgs(argv)
  if (flags.help) {
    out(PAIR_USAGE)
    return 0
  }
  const ttlMinutes = flags.ttl ? Number(flags.ttl) : undefined
  if (ttlMinutes !== undefined && !(ttlMinutes > 0)) {
    process.stderr.write("bureau pair: --ttl must be a positive number of minutes\n")
    return 2
  }
  const reply = await controlRequest(home, {
    op: "offer",
    ...(flags.rendezvous ? { rendezvousUrl: flags.rendezvous } : {}),
    ...(ttlMinutes ? { ttlMs: Math.round(ttlMinutes * 60_000) } : {}),
  })
  if (!reply) {
    process.stderr.write("bureau pair: no Bureau is running here. Start it with `bureau start`, then retry.\n")
    return 1
  }
  if (!reply.ok) {
    process.stderr.write(`bureau pair: ${reply.error}\n`)
    return 1
  }
  if (!("offer" in reply)) return 1
  out(await formatOffer(reply.offer, flags["no-qr"] !== "true"))
  return 0
}

export function formatDevices(devices: readonly DeviceSummary[]): string {
  if (devices.length === 0) return "No paired devices. Use `bureau pair` or `bureau install-mcp`."
  return devices
    .map(d => {
      const seen = d.kind === "remote" && d.lastSeen ? `  last seen ${d.lastSeen}` : ""
      const note = d.legacy ? "  (legacy, re-pair required)" : ""
      return `${d.fingerprint}  ${d.kind.padEnd(6)}  ${d.name}${seen}${note}`
    })
    .join("\n")
}

export async function runDevices(argv: string[], home: string = bureauHome()): Promise<number> {
  const [sub, ...rest] = argv
  if (sub === undefined || sub === "--help" || sub === "help") {
    out(DEVICES_USAGE)
    return sub === undefined ? 2 : 0
  }
  if (sub === "list") {
    const reply = await controlRequest(home, { op: "list" })
    const devices =
      reply && reply.ok && "devices" in reply
        ? reply.devices
        : (await createOfflineRegistry(home).list()).map(summarizeDevice)
    out(formatDevices(devices))
    return 0
  }
  if (sub === "revoke") {
    const id = rest[0]
    if (!id) {
      process.stderr.write("bureau devices revoke: missing <fingerprint|name>\n")
      return 2
    }
    const reply = await controlRequest(home, { op: "revoke", id })
    const revoked =
      reply && reply.ok && "revoked" in reply
        ? reply.revoked
        : await createOfflineRegistry(home).revoke(id)
    if (!revoked) {
      process.stderr.write(`bureau devices revoke: no device matches "${id}"\n`)
      return 1
    }
    out(`Revoked ${id}. Its next request is refused.`)
    return 0
  }
  process.stderr.write(`bureau devices: unknown subcommand "${sub}"\n\n${DEVICES_USAGE}\n`)
  return 2
}
