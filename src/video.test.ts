import { afterEach, describe, expect, it, vi } from "vitest";
import type { DriverVideoFrameIndex } from "./dm";
import { DriverVideoPlayer, framesForClip, planVideoRanges, selectMediaSourceCtor, splitAnnexB } from "./video";

describe("driver video range planning", () => {
  it("backs up to the preceding keyframe and returns encode order", () => {
    const frames = [frame(0, 0, true), frame(1, 100), frame(2, 200), frame(3, 300, true), frame(4, 400)];
    expect(framesForClip(frames, 0.18, 0.45).map((item) => item.encodeIndex)).toEqual([0, 1, 2, 3, 4]);
    expect(framesForClip(frames, 0.32, 0.45).map((item) => item.encodeIndex)).toEqual([3, 4]);
    expect(framesForClip(frames, 1, 2)).toEqual([]);
    expect(framesForClip(frames, -2, -1)).toEqual([]);
  });

  it("keeps HEVC NAL units continuous inside a fetched byte stream", () => {
    const bytes = new Uint8Array([0, 0, 0, 1, 0x40, 1, 2, 0, 0, 1, 0x26, 0x80, 9]);
    expect(splitAnnexB(bytes).map((nalu) => [nalu.type, [...nalu.data]])).toEqual([
      [32, [0x40, 1, 2]],
      [19, [0x26, 0x80, 9]],
    ]);
  });

  it("uses the memory target without splitting a decodable GOP", () => {
    const frames = [frame(0, 0, true, 100), frame(1, 100, false, 100), frame(2, 200, true, 100)];
    expect(planVideoRanges(frames, 220)).toEqual([
      { start: 0, end: 299, frames: frames.slice(0, 2) },
      { start: 200, end: 299, frames: frames.slice(2) },
    ]);

    const longGop = [frame(0, 0, true, 150), frame(1, 150, false, 150), frame(2, 300, false, 150)];
    expect(planVideoRanges(longGop, 220)).toEqual([{ start: 0, end: 449, frames: longGop }]);
  });
});

describe("selectMediaSourceCtor", () => {
  const originalMediaSource = (globalThis as { MediaSource?: unknown }).MediaSource;
  const originalManagedMediaSource = (globalThis as { ManagedMediaSource?: unknown }).ManagedMediaSource;

  afterEach(() => {
    // Restore the environment the suite actually runs in (Node has no MediaSource by default).
    delete (globalThis as { MediaSource?: unknown }).MediaSource;
    delete (globalThis as { ManagedMediaSource?: unknown }).ManagedMediaSource;
    if (originalMediaSource !== undefined) {
      (globalThis as { MediaSource?: unknown }).MediaSource = originalMediaSource;
    }
    if (originalManagedMediaSource !== undefined) {
      (globalThis as { ManagedMediaSource?: unknown }).ManagedMediaSource = originalManagedMediaSource;
    }
  });

  it("prefers the standard MediaSource when both are available", () => {
    const standard = class MediaSource {};
    const managed = class ManagedMediaSource {};
    (globalThis as { MediaSource?: unknown }).MediaSource = standard;
    (globalThis as { ManagedMediaSource?: unknown }).ManagedMediaSource = managed;

    const selection = selectMediaSourceCtor();

    expect(selection).not.toBeNull();
    expect(selection?.ctor).toBe(standard);
    expect(selection?.managed).toBe(false);
  });

  it("falls back to ManagedMediaSource when only it is available (iOS path)", () => {
    delete (globalThis as { MediaSource?: unknown }).MediaSource;
    const managed = class ManagedMediaSource {};
    (globalThis as { ManagedMediaSource?: unknown }).ManagedMediaSource = managed;

    const selection = selectMediaSourceCtor();

    expect(selection).not.toBeNull();
    expect(selection?.ctor).toBe(managed);
    expect(selection?.managed).toBe(true);
  });

  it("returns null when neither is available (iOS < 17.1)", () => {
    delete (globalThis as { MediaSource?: unknown }).MediaSource;
    delete (globalThis as { ManagedMediaSource?: unknown }).ManagedMediaSource;

    expect(selectMediaSourceCtor()).toBeNull();
  });
});

describe("DriverVideoPlayer seeking", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("resumes requested playback when a pending unbuffered seek returns to buffered video", () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    let paused = true;
    const play = vi.fn(() => {
      paused = false;
      return Promise.resolve();
    });
    const video = {
      buffered: { length: 1, start: () => 0, end: () => 20 },
      currentTime: 0,
      error: null,
      get paused() { return paused; },
      play,
    } as unknown as HTMLVideoElement;
    // managed=false: this test exercises the desktop/MediaSource seek path,
    // not ManagedMediaSource attach. The constructor requires the flag (added
    // alongside the iOS ManagedMediaSource path) since this branch rebases on
    // top of that change.
    const player = new DriverVideoPlayer(video, false);
    (player as unknown as { pendingSeekTime: number | null }).pendingSeekTime = 30;
    (player as unknown as { playbackRequested: boolean }).playbackRequested = true;
    (player as unknown as { resumeAfterSeek: boolean }).resumeAfterSeek = true;

    player.seek(10);
    vi.advanceTimersByTime(0);

    expect(video.currentTime).toBe(10);
    expect(play).toHaveBeenCalledOnce();
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
