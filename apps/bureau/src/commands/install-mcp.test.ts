import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createOfflineRegistry } from "../lib/pairing.js"
import { installMcp, runInstallMcp } from "./install-mcp.js"

let tmp: string
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "bureau-imcp-"))
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(tmp, { recursive: true, force: true })
})

interface ServerEntry {
  type?: string
  url: string
  headers: { Authorization: string }
}
async function readServers(path: string): Promise<Record<string, ServerEntry>> {
  const cfg = JSON.parse(await readFile(path, "utf8")) as { mcpServers: Record<string, ServerEntry> }
  return cfg.mcpServers
}
const bearerIn = (e: ServerEntry): string => e.headers.Authorization.replace(/^Bearer /, "")

describe("bureau install-mcp", () => {
  it("writes a device bearer into the host config, keeping everything else", async () => {
    const configPath = join(tmp, ".claude.json")
    await writeFile(
      configPath,
      JSON.stringify({ theme: "dark", mcpServers: { other: { type: "http", url: "http://x", headers: {} } } })
    )
    const registry = createOfflineRegistry(tmp)
    const res = await installMcp({ client: "claude", configPath, url: "http://127.0.0.1:8830/mcp", registry })

    expect(res.replaced).toBe(false)
    const cfg = JSON.parse(await readFile(configPath, "utf8")) as { theme: string }
    expect(cfg.theme).toBe("dark")
    const servers = await readServers(configPath)
    expect(Object.keys(servers).sort()).toEqual(["bureau", "other"])
    expect(servers.bureau).toMatchObject({ type: "http", url: "http://127.0.0.1:8830/mcp" })
    expect(await registry.verifyDeviceBearer(bearerIn(servers.bureau as ServerEntry))).toMatchObject({
      fingerprint: res.fingerprint,
    })
    expect((await stat(configPath)).mode & 0o777).toBe(0o600)
  })

  it("is idempotent: a re-run replaces its own entry, revokes the superseded device, never duplicates", async () => {
    const configPath = join(tmp, ".claude.json")
    const registry = createOfflineRegistry(tmp)
    const url = "http://127.0.0.1:8830/mcp"

    const first = await installMcp({ client: "claude", configPath, url, registry })
    const firstBearer = bearerIn((await readServers(configPath)).bureau as ServerEntry)

    const second = await installMcp({ client: "claude", configPath, url, registry })
    const servers = await readServers(configPath)
    const secondBearer = bearerIn(servers.bureau as ServerEntry)

    expect(Object.keys(servers)).toEqual(["bureau"])
    expect(second.replaced).toBe(true)
    expect(second.revokedFingerprint).toBe(first.fingerprint)
    expect(second.fingerprint).not.toBe(first.fingerprint)
    expect(await registry.verifyDeviceBearer(firstBearer)).toBeNull()
    expect(await registry.verifyDeviceBearer(secondBearer)).toMatchObject({ fingerprint: second.fingerprint })

    const locals = (await registry.list()).filter(r => r.local)
    expect(locals.map(r => r.fingerprint)).toEqual([second.fingerprint])

    await installMcp({ client: "claude", configPath, url, registry })
    expect((await registry.list()).filter(r => r.local)).toHaveLength(1)
    expect(Object.keys(await readServers(configPath))).toEqual(["bureau"])
  })

  it("writes the cursor shape (no type field) to an injected path", async () => {
    const configPath = join(tmp, "nested", "mcp.json")
    const registry = createOfflineRegistry(tmp)
    await installMcp({ client: "cursor", configPath, url: "http://127.0.0.1:1/mcp", registry })
    const entry = (await readServers(configPath)).bureau as ServerEntry
    expect(entry.type).toBeUndefined()
    expect(entry.headers.Authorization).toMatch(/^Bearer apd1\./)
  })

  it("leaves a malformed config untouched and mints nothing", async () => {
    const configPath = join(tmp, ".claude.json")
    await writeFile(configPath, "{ not json")
    const registry = createOfflineRegistry(tmp)
    await expect(
      installMcp({ client: "claude", configPath, url: "http://127.0.0.1:1/mcp", registry })
    ).rejects.toThrow(/not valid JSON/)
    expect(await readFile(configPath, "utf8")).toBe("{ not json")
    expect(await registry.list()).toEqual([])
  })

  it("never prints the bearer", async () => {
    const lines: string[] = []
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(" ")))
    const prevHome = process.env.BUREAU_HOME
    process.env.BUREAU_HOME = tmp
    try {
      const configPath = join(tmp, "cursor.json")
      const code = await runInstallMcp(["--client", "cursor", "--config", configPath])
      expect(code).toBe(0)
      const bearer = bearerIn((await readServers(configPath)).bureau as ServerEntry)
      expect(lines.join("\n")).not.toContain(bearer)
      expect(lines.join("\n")).not.toContain(bearer.split(".")[2] ?? "no-mac")
    } finally {
      if (prevHome === undefined) delete process.env.BUREAU_HOME
      else process.env.BUREAU_HOME = prevHome
    }
  })
})
