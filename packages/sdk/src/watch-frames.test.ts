import { describe, it, expect } from "vitest"
import type { BureauFrame } from "./schemas.js"
import {
  STOP_SENTINEL,
  appendBounded,
  parseFrameMessage,
} from "./watch-frames.js"

const frame = (index: number): BureauFrame => ({
  data: "AAAA",
  format: "jpeg",
  timestampMs: 1000 + index,
  index,
})

describe("parseFrameMessage", () => {
  it("parses a well-formed frame message", () => {
    expect(parseFrameMessage(JSON.stringify(frame(0)))).toEqual(frame(0))
  })

  it("strips unknown keys but keeps a valid frame", () => {
    const withExtra = JSON.stringify({
      ...frame(2),
      cookie: "secret",
      extra: 1,
    })
    expect(parseFrameMessage(withExtra)).toEqual(frame(2))
  })

  it("drops non-string payloads (producer streams text frames)", () => {
    expect(parseFrameMessage(frame(0))).toBeNull() // already an object, not text
    expect(parseFrameMessage(123)).toBeNull()
    expect(parseFrameMessage(null)).toBeNull()
    expect(parseFrameMessage(undefined)).toBeNull()
  })

  it("drops malformed JSON", () => {
    expect(parseFrameMessage("{not json")).toBeNull()
    expect(parseFrameMessage("")).toBeNull()
  })

  it("drops JSON that doesn't match the frame shape", () => {
    expect(
      parseFrameMessage(
        JSON.stringify({ data: "x", format: "gif", timestampMs: 1, index: 0 })
      )
    ).toBeNull() // format not in enum
    expect(
      parseFrameMessage(JSON.stringify({ data: "x", format: "jpeg", index: 0 }))
    ).toBeNull() // missing timestampMs
    expect(
      parseFrameMessage(
        JSON.stringify({
          data: "x",
          format: "jpeg",
          timestampMs: "1",
          index: 0,
        })
      )
    ).toBeNull() // timestampMs wrong type
  })
})

describe("appendBounded", () => {
  it("appends while under the cap", () => {
    let buf: BureauFrame[] = []
    buf = appendBounded(buf, frame(0), 3)
    buf = appendBounded(buf, frame(1), 3)
    expect(buf).toEqual([frame(0), frame(1)])
  })

  it("evicts from the front once at the cap, keeping the newest", () => {
    let buf: BureauFrame[] = [frame(0), frame(1), frame(2)]
    buf = appendBounded(buf, frame(3), 3)
    expect(buf).toEqual([frame(1), frame(2), frame(3)])
    expect(buf).toHaveLength(3)
  })

  it("never mutates the input buffer", () => {
    const original: BureauFrame[] = [frame(0), frame(1), frame(2)]
    appendBounded(original, frame(3), 3)
    expect(original).toEqual([frame(0), frame(1), frame(2)])
  })

  it("floors the cap at 1", () => {
    expect(appendBounded([frame(0)], frame(1), 0)).toEqual([frame(1)])
  })
})

describe("STOP_SENTINEL", () => {
  it("contains 'stop' so the producer's includes('stop') check ends the pump", () => {
    expect(STOP_SENTINEL).toContain("stop")
  })
})
