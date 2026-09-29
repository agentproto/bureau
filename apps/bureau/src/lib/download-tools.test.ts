import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { HumanSession } from "./ports.js"
import {
  BROWSER_DOWNLOAD_MAX_BYTES,
  createDownloadEntry,
} from "./download-tools.js"

/** A minimal HumanSession double — only navigate/click matter here. */
function fakeHumanSession(overrides: Partial<HumanSession> = {}): HumanSession {
  return {
    navigate: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue(undefined),
    gotoPaced: vi.fn().mockResolvedValue(undefined),
    scroll: vi.fn().mockResolvedValue(undefined),
    acceptConsent: vi.fn().mockResolvedValue(false),
    type: vi.fn().mockResolvedValue(undefined),
    click: vi.fn().mockResolvedValue(undefined),
    press: vi.fn().mockResolvedValue(undefined),
    isBlocked: vi.fn().mockResolvedValue(false),
    readNextData: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

interface FakeDownloadEntry {
  id: string
  url: string
  suggestedFilename: string
  mimeType: string
  bytes: number | null
  createdAt: string
  failure: string | null
  dataBase64?: string
  dataSkipped?: string
}

/** A tiny fake camofox REST surface: GET /tabs and GET /tabs/:id/downloads,
 *  scripted by the test. `pushDownload` simulates the async `page.on
 *  ('download', ...)` listener landing a new capture after the trigger. */
function fakeCamofox(opts: { tabId?: string } = {}): {
  fetchImpl: typeof fetch
  pushDownload: (entry: FakeDownloadEntry) => void
  tabExists: () => void
} {
  let tabId: string | undefined = opts.tabId
  const downloads: FakeDownloadEntry[] = []

  const fetchImpl = (async (input: string | URL) => {
    const url = new URL(String(input))
    if (url.pathname === "/tabs") {
      const tabs = tabId ? [{ tabId }] : []
      return new Response(JSON.stringify({ running: true, tabs }), {
        status: 200,
      })
    }
    const m = /^\/tabs\/([^/]+)\/downloads$/.exec(url.pathname)
    if (m) {
      return new Response(JSON.stringify({ tabId: m[1], downloads }), {
        status: 200,
      })
    }
    return new Response("not found", { status: 404 })
  }) as typeof fetch

  return {
    fetchImpl,
    pushDownload: entry => downloads.push(entry),
    tabExists: () => {
      tabId = tabId ?? "tab-1"
    },
  }
}

let artifactsDir: string
let prevArtifactsDir: string | undefined

beforeEach(() => {
  artifactsDir = mkdtempSync(join(tmpdir(), "bureau-download-test-"))
  prevArtifactsDir = process.env.BUREAU_ARTIFACTS_DIR
  process.env.BUREAU_ARTIFACTS_DIR = artifactsDir
})

afterEach(() => {
  if (prevArtifactsDir === undefined) delete process.env.BUREAU_ARTIFACTS_DIR
  else process.env.BUREAU_ARTIFACTS_DIR = prevArtifactsDir
  rmSync(artifactsDir, { recursive: true, force: true })
})

function pdfBytes(): Buffer {
  return Buffer.from("%PDF-1.4 fake invoice bytes")
}

describe("browser_download", () => {
  it("downloads by url: triggers via navigate, treats the download-starting rejection as success", async () => {
    const camofox = fakeCamofox({ tabId: "tab-1" })
    const bytes = pdfBytes()
    const human = fakeHumanSession({
      navigate: vi.fn().mockImplementation(async () => {
        // The download event fires asynchronously as a side effect of the
        // navigation that starts it — pushed here to model that ordering.
        camofox.pushDownload({
          id: "dl_1",
          url: "https://www.ovh.com/cgi-bin/order/bill.pdf?x=1",
          suggestedFilename: "FR123.pdf",
          mimeType: "application/pdf",
          bytes: bytes.length,
          createdAt: new Date().toISOString(),
          failure: null,
          dataBase64: bytes.toString("base64"),
        })
        throw new Error("Download is starting")
      }),
    })
    const entry = createDownloadEntry({
      resolvePooledDriver: async () => human,
      camofoxBase: "http://fake-camofox",
      fetchImpl: camofox.fetchImpl,
      pollIntervalMs: 5,
    })

    const result = await entry.call({
      session: "ovh",
      url: "https://www.ovh.com/cgi-bin/order/bill.pdf?x=1",
    })
    const parsed = JSON.parse((result.content[0] as { text: string }).text) as {
      fileName: string
      mimeType: string
      sizeBytes: number
      sha256: string
      path: string
    }

    expect(parsed.fileName).toBe("FR123.pdf")
    expect(parsed.mimeType).toBe("application/pdf")
    expect(parsed.sizeBytes).toBe(bytes.length)
    expect(parsed.sha256).toBe(createHash("sha256").update(bytes).digest("hex"))
    expect(readFileSync(parsed.path)).toEqual(bytes)
    expect(human.navigate).toHaveBeenCalledWith(
      "https://www.ovh.com/cgi-bin/order/bill.pdf?x=1"
    )
  })

  it("downloads by selector: clicks instead of navigating", async () => {
    const camofox = fakeCamofox({ tabId: "tab-1" })
    const bytes = Buffer.from("selector-triggered bytes")
    const human = fakeHumanSession({
      click: vi.fn().mockImplementation(async () => {
        camofox.pushDownload({
          id: "dl_1",
          url: "https://example.com/file.bin",
          suggestedFilename: "file.bin",
          mimeType: "application/octet-stream",
          bytes: bytes.length,
          createdAt: new Date().toISOString(),
          failure: null,
          dataBase64: bytes.toString("base64"),
        })
      }),
    })
    const entry = createDownloadEntry({
      resolvePooledDriver: async () => human,
      camofoxBase: "http://fake-camofox",
      fetchImpl: camofox.fetchImpl,
      pollIntervalMs: 5,
    })

    const result = await entry.call({ session: "ovh", selector: "#dl-link" })
    const parsed = JSON.parse((result.content[0] as { text: string }).text) as {
      fileName: string
    }

    expect(human.click).toHaveBeenCalledWith("#dl-link")
    expect(human.navigate).not.toHaveBeenCalled()
    expect(parsed.fileName).toBe("file.bin")
  })

  it("times out cleanly when no download ever lands", async () => {
    const camofox = fakeCamofox({ tabId: "tab-1" })
    const human = fakeHumanSession()
    const entry = createDownloadEntry({
      resolvePooledDriver: async () => human,
      camofoxBase: "http://fake-camofox",
      fetchImpl: camofox.fetchImpl,
      pollIntervalMs: 5,
    })

    await expect(
      entry.call({ session: "ovh", selector: "#dl-link", timeoutMs: 1_000 })
    ).rejects.toThrow(/no download captured/)
  })

  it("refuses an oversized download without reading its bytes", async () => {
    const camofox = fakeCamofox({ tabId: "tab-1" })
    const human = fakeHumanSession({
      navigate: vi.fn().mockImplementation(async () => {
        camofox.pushDownload({
          id: "dl_1",
          url: "https://example.com/huge.bin",
          suggestedFilename: "huge.bin",
          mimeType: "application/octet-stream",
          bytes: BROWSER_DOWNLOAD_MAX_BYTES + 1,
          createdAt: new Date().toISOString(),
          failure: null,
          dataSkipped: "max_bytes_exceeded",
        })
        throw new Error("Download is starting")
      }),
    })
    const entry = createDownloadEntry({
      resolvePooledDriver: async () => human,
      camofoxBase: "http://fake-camofox",
      fetchImpl: camofox.fetchImpl,
      pollIntervalMs: 5,
    })

    await expect(
      entry.call({ session: "ovh", url: "https://example.com/huge.bin" })
    ).rejects.toThrow(/too large/)
  })

  it("refuses a non-http(s) url before ever touching the browser", async () => {
    const human = fakeHumanSession()
    const entry = createDownloadEntry({
      resolvePooledDriver: async () => human,
      camofoxBase: "http://fake-camofox",
      fetchImpl: fakeCamofox().fetchImpl,
      pollIntervalMs: 5,
    })

    await expect(
      entry.call({ session: "ovh", url: "javascript:alert(1)" })
    ).rejects.toThrow(/http\(s\)/)
    expect(human.navigate).not.toHaveBeenCalled()
    expect(human.click).not.toHaveBeenCalled()
  })

  it("requires either url or selector", async () => {
    const human = fakeHumanSession()
    const entry = createDownloadEntry({
      resolvePooledDriver: async () => human,
      camofoxBase: "http://fake-camofox",
      fetchImpl: fakeCamofox().fetchImpl,
    })

    await expect(entry.call({ session: "ovh" })).rejects.toThrow(
      /`url` or `selector` is required/
    )
  })

  it("waits for the tab to be created when it doesn't exist yet, then finds the download", async () => {
    const camofox = fakeCamofox() // no tab initially
    const bytes = Buffer.from("late-tab bytes")
    const human = fakeHumanSession({
      navigate: vi.fn().mockImplementation(async () => {
        // Simulate camofox auto-creating the tab on first navigate, and the
        // download landing shortly after.
        camofox.tabExists()
        camofox.pushDownload({
          id: "dl_1",
          url: "https://example.com/late.pdf",
          suggestedFilename: "late.pdf",
          mimeType: "application/pdf",
          bytes: bytes.length,
          createdAt: new Date().toISOString(),
          failure: null,
          dataBase64: bytes.toString("base64"),
        })
        throw new Error("Download is starting")
      }),
    })
    const entry = createDownloadEntry({
      resolvePooledDriver: async () => human,
      camofoxBase: "http://fake-camofox",
      fetchImpl: camofox.fetchImpl,
      pollIntervalMs: 5,
    })

    const result = await entry.call({
      session: "ovh",
      url: "https://example.com/late.pdf",
    })
    const parsed = JSON.parse((result.content[0] as { text: string }).text) as {
      fileName: string
    }
    expect(parsed.fileName).toBe("late.pdf")
  })
})
