/**
 * In-memory rendezvous fake and the client half of the pair/v2 handshake, for
 * remote-pairing tests. Adapted from `@agentproto/pairing-host`'s own test
 * fixtures (which are not exported): a host-side `dial` that parks under its
 * route token, and a client dial that meets it.
 */

import { vi } from "vitest"
import {
  createTunnelClient,
  clientHandshakeOverSink,
  type FrameSink,
  type TunnelClient,
} from "@agentproto/acp/tunnel"
import {
  startClientHandshake,
  encodePairingMessage,
  decodePairingReply,
  parseOfferUrl,
  deriveOfferTokens,
  type PairingSession,
} from "@agentproto/secrets/pairing"
import { connect } from "./frame-harness.js"

export class FakeRendezvous {
  private parked = new Map<string, FrameSink[]>()
  private clientEnds = new Map<FrameSink, FrameSink>()
  readonly dialedUrls: string[] = []

  dial = async (url: string): Promise<FrameSink> => {
    this.dialedUrls.push(url)
    const token = new URL(url).searchParams.get("t")
    if (!token) throw new Error("fake rendezvous: no route token")
    const { a, b } = connect()
    const list = this.parked.get(token) ?? []
    list.push(b)
    this.parked.set(token, list)
    this.clientEnds.set(b, a)
    return b
  }

  async dialClient(route: string): Promise<FrameSink> {
    let end: FrameSink | undefined
    await vi.waitFor(() => {
      end = (this.parked.get(route) ?? []).find(s => s.isOpen)
      if (!end) throw new Error(`nothing parked on ${route}`)
    })
    const host = end as FrameSink
    this.parked.set(route, (this.parked.get(route) ?? []).filter(s => s !== host))
    return this.clientEnds.get(host) as FrameSink
  }
}

/** Client side of `pair accept` over the fake rendezvous. */
export async function pairViaOffer(
  rv: FakeRendezvous,
  offerUrl: string,
  name: string
): Promise<{ client: TunnelClient }> {
  const parsed = await parseOfferUrl(offerUrl)
  const tokens = await deriveOfferTokens(parsed.secret)
  const raw = await rv.dialClient(tokens.route)
  const started = await startClientHandshake({
    daemonX25519Pub: parsed.daemonX25519Pub,
    daemonEd25519Pub: parsed.daemonEd25519Pub,
    authToken: tokens.auth,
    clientName: name,
  })
  let session: PairingSession | null = null
  const wrapped = await clientHandshakeOverSink(
    raw,
    encodePairingMessage(started.hello),
    async replyBytes => {
      session = await started.complete(decodePairingReply(replyBytes))
      return session
    },
    { timeoutMs: 3_000 }
  )
  if (!session) throw new Error("handshake did not derive a session")
  return { client: createTunnelClient({ sink: wrapped }) }
}
