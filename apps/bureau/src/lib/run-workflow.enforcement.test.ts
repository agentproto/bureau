/**
 * run-workflow — the host-side `enforcement:"server"` branch.
 *
 * Proves the host only builds the synthesize port (and only fails closed) for a
 * server-enforced run, and leaves honor/free/offline runs byte-for-byte
 * unchanged (PLAN Decision 5 backward-compat + the §4 fail-closed invariant).
 * The resolver driver-swap itself is covered in browser-actions'
 * `remote-distill.provider.test.ts`; here we exercise the branch conditions.
 * The synthesize port is supplied by a plugin through the workflow hooks (core
 * has no cloud link of its own), so a server-enforced live run with no hook
 * fails closed.
 */

import { afterEach, describe, it, expect } from "vitest"
import type { WorkflowDescriptor, WorkflowPrice } from "./recipe-types.js"
import type { SynthesizePort } from "./ports.js"
import { buildWorkflowCaps, isServerEnforced } from "./run-workflow.js"
import { resetWorkflowHooks, setWorkflowHooks } from "./workflow-hooks.js"

afterEach(() => resetWorkflowHooks())

/** A minimal but fully-typed descriptor with NO caps — isolates the enforcement
 *  branch from session/model/deliver resolution. `compile` is never called by
 *  `buildWorkflowCaps`, so a throwing stub (return type `never`) is fine. */
function makeDesc(price?: WorkflowPrice): WorkflowDescriptor {
  return {
    id: "test-wf",
    name: "Test workflow",
    description: "unit test descriptor",
    manifest: "",
    tools: {},
    contextFor: () => undefined,
    candidates: [],
    caps: [],
    inputs: [],
    inputFromFlags: () => ({}),
    compile: () => {
      throw new Error("compile not exercised in this unit test")
    },
    ...(price ? { price } : {}),
  }
}

const SERVER_PRICE: WorkflowPrice = {
  credits: 90,
  author: "house",
  enforcement: "server",
}
const HONOR_PRICE: WorkflowPrice = {
  credits: 5,
  author: "house",
  enforcement: "honor",
}

describe("isServerEnforced", () => {
  it("true for enforcement:server, false for honor / free", () => {
    expect(isServerEnforced(makeDesc(SERVER_PRICE))).toBe(true)
    expect(isServerEnforced(makeDesc(HONOR_PRICE))).toBe(false)
    expect(isServerEnforced(makeDesc())).toBe(false)
  })
})

describe("buildWorkflowCaps — server-enforced branch", () => {
  it("fail-closed invariant: server-enforced with NO runId throws (would else distill locally)", async () => {
    await expect(
      buildWorkflowCaps(makeDesc(SERVER_PRICE), {}, undefined, undefined)
    ).rejects.toThrow(/no runId/i)
  })

  it("honor run never builds the synthesize port (even with a runId)", async () => {
    const caps = await buildWorkflowCaps(
      makeDesc(HONOR_PRICE),
      {},
      undefined,
      "run-honor"
    )
    expect(caps.synthesize).toBeUndefined()
  })

  it("free run never builds the synthesize port", async () => {
    const caps = await buildWorkflowCaps(makeDesc(), {}, undefined, "run-free")
    expect(caps.synthesize).toBeUndefined()
  })

  it("offline dry run of a server-enforced workflow skips the port (uses local stubs)", async () => {
    const caps = await buildWorkflowCaps(
      makeDesc(SERVER_PRICE),
      { offline: true },
      undefined,
      "run-offline"
    )
    expect(caps.synthesize).toBeUndefined()
  })

  it("live server-enforced run with a runId but no synthesize hook fails closed", async () => {
    await expect(
      buildWorkflowCaps(makeDesc(SERVER_PRICE), {}, undefined, "run-live")
    ).rejects.toThrow(/no cloud link/i)
  })

  it("live server-enforced run gets the port a plugin's hook resolves", async () => {
    const port: SynthesizePort = { synthesize: async () => ({ entries: [], distilled: 0, skipped: 0 }) }
    setWorkflowHooks({ resolveSynthesize: async () => port })
    const caps = await buildWorkflowCaps(
      makeDesc(SERVER_PRICE),
      {},
      undefined,
      "run-live"
    )
    expect(caps.synthesize).toBe(port)
  })
})
