import { describe, expect, it, vi } from "vitest"
import {
  findOrphanCamoufoxChildren,
  reapOrphanCamoufoxChildren,
  type ProcessRow,
} from "./reap-orphans.js"

describe("findOrphanCamoufoxChildren", () => {
  it("finds a camoufox process reparented to init (ppid 1)", () => {
    const rows: ProcessRow[] = [
      { pid: 100, ppid: 1, comm: "node" },
      { pid: 200, ppid: 1, comm: "camoufox" },
    ]
    expect(findOrphanCamoufoxChildren(rows)).toEqual([
      { pid: 200, ppid: 1, comm: "camoufox" },
    ])
  })

  it("finds a camoufox process whose ppid is an explicitly dead managed pid", () => {
    const rows: ProcessRow[] = [
      { pid: 300, ppid: 999, comm: "camoufox" }, // 999 = old, now-dead camofox server
    ]
    expect(
      findOrphanCamoufoxChildren(rows, { deadManagedPids: new Set([999]) })
    ).toEqual([{ pid: 300, ppid: 999, comm: "camoufox" }])
  })

  it("never touches a camoufox process parented by the CURRENT live managed server", () => {
    const rows: ProcessRow[] = [
      { pid: 400, ppid: 500, comm: "camoufox" }, // 500 = current, still-alive server
    ]
    expect(
      findOrphanCamoufoxChildren(rows, { deadManagedPids: new Set([999]) })
    ).toEqual([])
  })

  it("never matches a non-camoufox process, even if reparented to init", () => {
    const rows: ProcessRow[] = [{ pid: 100, ppid: 1, comm: "some-other-browser" }]
    expect(findOrphanCamoufoxChildren(rows)).toEqual([])
  })
})

describe("reapOrphanCamoufoxChildren", () => {
  it("sends SIGTERM to every orphan and returns their pids, touching nothing else", async () => {
    const rows: ProcessRow[] = [
      { pid: 1, ppid: 0, comm: "launchd" },
      { pid: 500, ppid: 1, comm: "node" }, // the CURRENT camofox server — not camoufox comm
      { pid: 501, ppid: 500, comm: "camoufox" }, // legitimate live child
      { pid: 600, ppid: 999, comm: "camoufox" }, // orphan: parent 999 is dead
      { pid: 601, ppid: 1, comm: "camoufox" }, // orphan: reparented to init
    ]
    const killed: Array<{ pid: number; signal?: string }> = []
    const pids = await reapOrphanCamoufoxChildren({
      deadManagedPids: new Set([999]),
      listProcesses: async () => rows,
      killProcess: (pid, signal) => killed.push({ pid, signal }),
    })

    expect(pids.sort()).toEqual([600, 601])
    expect(killed).toEqual(
      expect.arrayContaining([
        { pid: 600, signal: "SIGTERM" },
        { pid: 601, signal: "SIGTERM" },
      ])
    )
    expect(killed).toHaveLength(2)
    expect(killed.some(k => k.pid === 501)).toBe(false) // legitimate child untouched
  })

  it("logs each reap and never calls killProcess when there are no orphans", async () => {
    const log = vi.fn()
    const killProcess = vi.fn()
    const pids = await reapOrphanCamoufoxChildren({
      listProcesses: async () => [{ pid: 1, ppid: 0, comm: "launchd" }],
      killProcess,
      log,
    })
    expect(pids).toEqual([])
    expect(killProcess).not.toHaveBeenCalled()
    expect(log).not.toHaveBeenCalled()
  })
})
