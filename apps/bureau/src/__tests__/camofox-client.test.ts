/**
 * Tests for `@agentproto/bureau-drivers/camofox`'s REST client — the salvage
 * patch folded into lane L0 (refs/salvage/stash/2026-06-27-36,
 * 2026-09-03-14): throw on a non-2xx response instead of returning it as if
 * it were a normal body, and send `Authorization: Bearer <apiKey>` when
 * configured.
 *
 * NOTE: the package export resolves to `@agentproto/bureau-drivers`'s built
 * `dist/`, not `src/` — after editing `packages/drivers/src/camofox/client.ts`
 * its dist was rebuilt once with the package's own local
 * `./node_modules/.bin/tsup` (no `pnpm --filter`, no install, no lockfile
 * touch) so this import reflects the new behaviour.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { createCamofoxRestClient } from "@agentproto/bureau-drivers/camofox"

const originalFetch = globalThis.fetch
const originalApiKey = process.env.CAMOFOX_API_KEY

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalApiKey === undefined) delete process.env.CAMOFOX_API_KEY
  else process.env.CAMOFOX_API_KEY = originalApiKey
})

describe("createCamofoxRestClient — non-2xx throws", () => {
  it("throws (instead of returning the error body as a normal result) on a 500", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "tab create timed out after 30000ms" }), {
        status: 500,
      })
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const client = createCamofoxRestClient({ baseUrl: "http://127.0.0.1:9377" })
    await expect(client.createSession()).rejects.toThrow(/HTTP 500/)
  })

  it("still resolves normally on a 2xx", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ tabId: "abc123" }), { status: 200 })
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const client = createCamofoxRestClient({ baseUrl: "http://127.0.0.1:9377" })
    const session = await client.createSession()
    expect(session.id).toBe("abc123")
  })
})

describe("createCamofoxRestClient — apiKey Bearer auth", () => {
  it("sends Authorization: Bearer <apiKey> on a JSON request when configured", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ tabId: "t1" }), { status: 200 }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const client = createCamofoxRestClient({
      baseUrl: "http://127.0.0.1:9377",
      apiKey: "sekrit-key",
    })
    await client.createSession()

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer sekrit-key"
    )
  })

  it("falls back to CAMOFOX_API_KEY from the environment", async () => {
    process.env.CAMOFOX_API_KEY = "env-key"
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ tabId: "t1" }), { status: 200 }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const client = createCamofoxRestClient({ baseUrl: "http://127.0.0.1:9377" })
    await client.createSession()

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer env-key")
  })

  it("sends no Authorization header when no apiKey is configured", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ tabId: "t1" }), { status: 200 }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const client = createCamofoxRestClient({ baseUrl: "http://127.0.0.1:9377" })
    await client.createSession()

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined()
  })
})
