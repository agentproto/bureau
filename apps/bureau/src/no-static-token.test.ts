import { describe, expect, it } from "vitest"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { dirname, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, "../../..")
const SELF = relative(repo, fileURLToPath(import.meta.url))

// Pairing is the only auth: no shared static secret in env, config or docs.
const STATIC_TOKEN =
  /\bBUREAU_(?:(?:AUTH|API|ACCESS|SECRET|BEARER|MCP)_)?(?:TOKEN|KEY|SECRET|PASSWORD)\b/

function sourceFiles(): string[] {
  const listed = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: repo,
    encoding: "utf8",
  })
  return listed.split("\0").filter(f => f && f !== SELF)
}

describe("no static token scheme", () => {
  it("matches the patterns it claims to forbid", () => {
    for (const bad of ["BUREAU_TOKEN", "BUREAU_AUTH_TOKEN", "BUREAU_API_KEY", "BUREAU_MCP_TOKEN"])
      expect(STATIC_TOKEN.test(`process.env.${bad}`), bad).toBe(true)
    for (const fine of ["BUREAU_HOME", "BUREAU_PORT", "BUREAU_HOST", "BUREAU_PLUGINS", "BUREAU_TOKENS_OK_X"])
      expect(STATIC_TOKEN.test(fine), fine).toBe(false)
  })

  it("finds no BUREAU_TOKEN-style variable in tracked or new files", () => {
    const hits: string[] = []
    for (const file of sourceFiles()) {
      let text: string
      try {
        text = readFileSync(resolve(repo, file), "utf8")
      } catch {
        continue
      }
      text.split("\n").forEach((line, i) => {
        if (STATIC_TOKEN.test(line)) hits.push(`${file}:${i + 1}`)
      })
    }
    expect(hits).toEqual([])
  })
})
