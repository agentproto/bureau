import { afterEach, describe, expect, it } from "vitest"
import { resolveHost } from "./serve.js"

const ORIGINAL_BUREAU_HOST = process.env.BUREAU_HOST

afterEach(() => {
  if (ORIGINAL_BUREAU_HOST === undefined) delete process.env.BUREAU_HOST
  else process.env.BUREAU_HOST = ORIGINAL_BUREAU_HOST
})

describe("resolveHost — default loopback bind (F1/Decision 5)", () => {
  it("defaults to 127.0.0.1 with no --host and no BUREAU_HOST", () => {
    delete process.env.BUREAU_HOST
    expect(resolveHost([])).toBe("127.0.0.1")
  })

  it("honours --host over the default", () => {
    delete process.env.BUREAU_HOST
    expect(resolveHost(["--host", "0.0.0.0"])).toBe("0.0.0.0")
  })

  it("honours BUREAU_HOST when no --host flag is given", () => {
    process.env.BUREAU_HOST = "0.0.0.0"
    expect(resolveHost([])).toBe("0.0.0.0")
  })

  it("--host takes precedence over BUREAU_HOST", () => {
    process.env.BUREAU_HOST = "0.0.0.0"
    expect(resolveHost(["--host", "127.0.0.1"])).toBe("127.0.0.1")
  })
})
