/** A real consent host over temp files, reading Chrome through a fake port that returns a canary cookie value. */

import { join } from "node:path"
import {
  createConsentHost,
  createConsentLedger,
  fileGrantStore,
  fileSessionStore,
  type ChromeProfilePort,
  type ConsentHost,
  type ConsentPrompt,
} from "@agentproto/browser-profiles"

export const CANARY = "canary-cookie-value-9b1e4f"

export interface FakeChrome extends ChromeProfilePort {
  reads: Array<{ profile: string; domains: readonly string[] }>
}

export function fakeChromePort(): FakeChrome {
  const reads: FakeChrome["reads"] = []
  return {
    reads,
    countByDomain: (_profile, domains) => ({ known: Object.fromEntries(domains.map(d => [d, 2])) }),
    countAll: () => ({ known: 7 }),
    readCookies(profile, domains) {
      reads.push({ profile, domains })
      return domains.map(domain => ({ name: "sid", value: CANARY, domain, path: "/", secure: true, httpOnly: true }))
    },
  }
}

export const consentPaths = (home: string): { grants: string; ledger: string; sessions: string; jars: string } => ({
  grants: join(home, "grants.json"),
  ledger: join(home, "consent-ledger.jsonl"),
  sessions: join(home, "sessions"),
  jars: join(home, "grant-jars"),
})

export function makeHost(home: string, chrome: ChromeProfilePort, prompt?: ConsentPrompt, now?: () => Date): ConsentHost {
  const p = consentPaths(home)
  return createConsentHost({
    grants: fileGrantStore(p.grants),
    ledger: createConsentLedger({ path: p.ledger }),
    store: fileSessionStore(p.sessions),
    jarDir: p.jars,
    chrome,
    ...(prompt ? { prompt } : {}),
    ...(now ? { now } : {}),
  })
}
