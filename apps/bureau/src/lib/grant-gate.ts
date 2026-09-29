/**
 * Per-device consent grants (L5b) at the tool boundary. Grants are keyed by the
 * paired device fingerprint that `authorize` resolved; the request context
 * (`currentDevice()`) carries it here, so a tool that touches a saved session
 * checks the calling device without every handler threading a parameter.
 *
 * Rules, for a call that names a `session`:
 *   - no device in context (a flavour without pairing, e.g. the studio's
 *     loopback-open): pass through, exactly as before;
 *   - the session has no consent grants at all: it is not consent-managed, pass;
 *   - it has grants: with a `url` argument the host must be covered by an active
 *     grant that serves THIS device; without one, some active grant must serve it.
 * A grant with no `deviceId` serves any device (L5b C12).
 */

import {
  ConsentRequiredError,
  CONSENT_REQUIRED_CODE,
  grantServesDevice,
  isGrantActive,
  type Grant,
} from "@agentproto/browser-profiles"
import type { McpEntry } from "../mcp-tool.js"
import { currentDevice } from "./device-context.js"

/** The slice of the L5b `ConsentHost` the gate needs. */
export interface GrantChecker {
  assertCovered(input: { sessionId: string; host: string; deviceId?: string }): Grant
  listGrants(): Grant[]
}

const hasSessionArg = (e: McpEntry): boolean => {
  const props = e.jsonSchema.properties
  return props !== undefined && Object.prototype.hasOwnProperty.call(props, "session")
}

function hostOf(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined
  try {
    return new URL(url).hostname
  } catch {
    return undefined
  }
}

/** Throws {@link ConsentRequiredError} when the calling device may not use `session` (for `url`). */
export function assertDeviceMaySeeSession(
  checker: GrantChecker,
  args: Record<string, unknown>
): void {
  const device = currentDevice()
  const session = typeof args.session === "string" ? args.session : undefined
  if (!device || !session) return

  const forSession = checker.listGrants().filter(g => g.sessionId === session)
  if (forSession.length === 0) return

  const host = hostOf(args.url)
  if (host) {
    checker.assertCovered({ sessionId: session, host, deviceId: device.fingerprint })
    return
  }
  const now = new Date()
  const served = forSession.some(
    g => isGrantActive(g, now) && grantServesDevice(g, device.fingerprint)
  )
  if (!served) throw new ConsentRequiredError("no active grant covers this session for this device")
}

/** Wrap every session-bearing entry so it enforces the calling device's grants. */
export function gateEntriesByDevice(entries: McpEntry[], checker: GrantChecker): McpEntry[] {
  return entries.map(entry =>
    hasSessionArg(entry)
      ? {
          ...entry,
          call: async args => {
            try {
              assertDeviceMaySeeSession(checker, args)
            } catch (e) {
              if (e instanceof ConsentRequiredError) {
                return {
                  isError: true,
                  content: [
                    {
                      type: "text",
                      text: JSON.stringify({ error: CONSENT_REQUIRED_CODE, message: e.message }),
                    },
                  ],
                }
              }
              throw e
            }
            return entry.call(args)
          },
        }
      : entry
  )
}
