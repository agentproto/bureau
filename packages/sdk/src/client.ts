/**
 * The typed Bureau client. Hosts inject a {@link BureauTransport}; the client
 * turns it into a small, validated API. A tool's payload is a JSON text block,
 * so each method pulls the first JSON block and zod-parses the field it owns —
 * a malformed/empty answer degrades to an empty list rather than throwing,
 * because a Bureau with no sessions is a normal state, not an error.
 */

import type { BureauTransport } from "./transport.js"
import {
  bureauSessionSchema,
  bureauTabSchema,
  type BureauSession,
  type BureauTab,
  type BureauSnapshot,
} from "./schemas.js"

function firstJsonBlock(
  content: Array<{ type: string; text?: string }>
): unknown {
  const text = content.find(b => b.type === "text")?.text
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

export interface BureauClient {
  /** Saved login identities the Bureau holds. */
  sessions(): Promise<BureauSession[]>
  /** Open tabs, optionally narrowed to one session. */
  tabs(session?: string): Promise<BureauTab[]>
  /**
   * One round-trip view: sessions + tabs + liveness. A transport failure means
   * the daemon didn't answer → `connected: false` with empty lists, never a
   * throw, so a UI can render "offline" uniformly.
   */
  snapshot(): Promise<BureauSnapshot>
}

export function createBureauClient(transport: BureauTransport): BureauClient {
  const sessions = async (): Promise<BureauSession[]> => {
    const res = await transport.callTool("bureau_sessions", {})
    const parsed = bureauSessionSchema
      .array()
      .safeParse(
        (firstJsonBlock(res.content) as { sessions?: unknown })?.sessions ?? []
      )
    return parsed.success ? parsed.data : []
  }

  const tabs = async (session?: string): Promise<BureauTab[]> => {
    const res = await transport.callTool(
      "bureau_tabs",
      session ? { session } : {}
    )
    const parsed = bureauTabSchema
      .array()
      .safeParse(
        (firstJsonBlock(res.content) as { tabs?: unknown })?.tabs ?? []
      )
    return parsed.success ? parsed.data : []
  }

  return {
    sessions,
    tabs,
    async snapshot(): Promise<BureauSnapshot> {
      try {
        const [s, t] = await Promise.all([sessions(), tabs()])
        return { connected: true, sessions: s, tabs: t }
      } catch {
        return { connected: false, sessions: [], tabs: [] }
      }
    },
  }
}
