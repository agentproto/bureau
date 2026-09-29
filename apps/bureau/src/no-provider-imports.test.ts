/**
 * Server code resolves browsers through the kit registry. Only the registry
 * wiring file may import a specific provider package or its client.
 */
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const here = dirname(fileURLToPath(import.meta.url))
const WIRING = "lib/browser-registry.ts"
const FORBIDDEN = /from\s+["'](@agentproto\/adapter-browser(?:-[a-z]+)?|@agentproto\/bureau-drivers\/camofox)["']/

describe("provider imports", () => {
  it("appear only in the registry wiring (tests and their fakes excepted)", () => {
    const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "--", "*.ts"], {
      cwd: here,
      encoding: "utf8",
    })
      .split("\n")
      .filter(f => f && !f.endsWith(".test.ts") && !f.startsWith("__tests__/"))
    expect(files.length).toBeGreaterThan(10)
    const offenders = files.filter(f => f !== WIRING && FORBIDDEN.test(readFileSync(join(here, f), "utf8")))
    expect(offenders, `import a provider only in ${relative(here, join(here, WIRING))}`).toEqual([])
    expect(FORBIDDEN.test(readFileSync(join(here, WIRING), "utf8"))).toBe(true)
  })
})
