import { describe, expect, it } from "vitest";
import type { DriverVideoFrameIndex } from "./dm";
import { framesForClip, planVideoRanges, splitAnnexB } from "./video";

describe("driver video range planning", () => {
  it("backs up to the preceding keyframe and returns encode order", () => {
    const frames = [frame(0, 0, true), frame(1, 100), frame(2, 200), frame(3, 300, true), frame(4, 400)];
    expect(framesForClip(frames, 0.18, 0.45).map((item) => item.encodeIndex)).toEqual([0, 1, 2, 3, 4]);
    expect(framesForClip(frames, 0.32, 0.45).map((item) => item.encodeIndex)).toEqual([3, 4]);
  });

  it("keeps HEVC NAL units continuous inside a fetched byte stream", () => {
    const bytes = new Uint8Array([0, 0, 0, 1, 0x40, 1, 2, 0, 0, 1, 0x26, 0x80, 9]);
    expect(splitAnnexB(bytes).map((nalu) => [nalu.type, [...nalu.data]])).toEqual([
      [32, [0x40, 1, 2]],
      [19, [0x26, 0x80, 9]],
    ]);
  });

  it("coalesces contiguous frames without exceeding the memory chunk cap", () => {
    const frames = [frame(0, 0, true, 100), frame(1, 100, false, 100), frame(2, 200, false, 100)];
    expect(planVideoRanges(frames, 220)).toEqual([
      { start: 0, end: 199, frames: frames.slice(0, 2) },
      { start: 200, end: 299, frames: frames.slice(2) },
    ]);
  });
});

function frame(encodeIndex: number, byteOffset: number, keyframe = false, byteLength = 100): DriverVideoFrameIndex {
  return {
    logMonoTime: 0n,
    segment: 0,
    presentationIndex: encodeIndex,
    encodeIndex,
    frameId: encodeIndex,
    timestampSof: BigInt(encodeIndex * 50_000_000),
    timestampEof: BigInt(encodeIndex * 50_000_000),
    byteOffset,
    byteLength,
    keyframe,
    routeSeconds: encodeIndex * 0.1,
    durationMs: 100,
    compositionTimeOffsetMs: 0,
  };
}
