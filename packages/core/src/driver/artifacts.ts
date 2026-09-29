/**
 * Node-only artifact helpers for the driver host (Bureau / headless server).
 *
 * These touch the filesystem, so they live apart from `mcp-tools.ts` and are
 * never pulled into the static import graph of the in-browser extension build
 * (which bundles the tool catalog but only ever returns base64 — it imports
 * these lazily, and only on the `path` branch). Keeping `node:fs/path/os` out of
 * that graph is what lets the extension (vite/rollup, browser externals) build.
 */

import { writeFileSync, mkdirSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { tmpdir } from "node:os"

/** Where `path`-relative screenshot / export artifacts land on the driver host
 *  (override with `BUREAU_ARTIFACTS_DIR`). */
export const bureauArtifactsDir = (): string =>
  process.env.BUREAU_ARTIFACTS_DIR || join(tmpdir(), "bureau-artifacts")

/**
 * Resolve an artifact path: an absolute path is used as-is (the caller chose
 * an explicit destination outside the sandbox, e.g. a scratchpad dir — that's
 * intentional and unrestricted). A relative path is sandboxed under
 * {@link bureauArtifactsDir} — `..` segments that would escape it are
 * rejected rather than silently normalized outside the dir. The parent dir is
 * created on write.
 */
export function resolveArtifactPath(p: string): string {
  if (isAbsolute(p)) return p
  const base = bureauArtifactsDir()
  const abs = resolve(base, p)
  const rel = relative(base, abs)
  // Exact match or a leading "../" segment — not just any name starting
  // with "..", which would wrongly reject a literal filename like
  // "..hidden.png".
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(
      `resolveArtifactPath: relative path "${p}" escapes the artifacts dir (${base})`
    )
  }
  return abs
}

/** Write bytes to an artifact path (creating the parent dir) and return the
 *  resolved absolute path. */
export function writeArtifact(p: string, bytes: Buffer): string {
  const abs = resolveArtifactPath(p)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, bytes)
  return abs
}
