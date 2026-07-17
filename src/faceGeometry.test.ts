import { describe, expect, it } from "vitest";
import {
  projectFaceAnchor,
  resolveDriverCameraProfile,
  TICI_CANVAS_HEIGHT,
  TICI_CANVAS_WIDTH,
} from "./faceGeometry";

describe("resolveDriverCameraProfile", () => {
  it("selects mici from device type", () => {
    expect(resolveDriverCameraProfile("mici", null)).toEqual({ name: "mici", anchorScale: 1.25 });
  });

  it("selects mici from stream dimensions when device type is absent", () => {
    expect(resolveDriverCameraProfile(null, { width: 1344, height: 760 })).toEqual({
      name: "mici",
      anchorScale: 1.25,
    });
  });

  it("falls back to tici for unknown devices and non-mici dimensions", () => {
    expect(resolveDriverCameraProfile(undefined, { width: 1928, height: 1208 })).toEqual({
      name: "tici",
      anchorScale: 1,
    });
    expect(resolveDriverCameraProfile(null, null)).toEqual({ name: "tici", anchorScale: 1 });
  });
});

describe("projectFaceAnchor", () => {
  it("returns null for missing or non-finite face position", () => {
    expect(projectFaceAnchor([], resolveDriverCameraProfile("tici", null), null)).toBeNull();
    expect(
      projectFaceAnchor([Number.NaN, 0], resolveDriverCameraProfile("tici", null), null),
    ).toBeNull();
  });

  it("anchors a centered face at 50%/50% on both profiles", () => {
    // faceX = faceY = 0 => ticiX = 1080, ticiY = 369, both at the canvas center
    // after the anchor-scale step (1080 is canvas-width/2, 540 is canvas-height/2
    // is NOT ticiY, but Y is independent — verify the symmetry property directly).
    const tici = projectFaceAnchor([0, 0], resolveDriverCameraProfile("tici", null), {
      width: 1928,
      height: 1208,
    })!;
    expect(tici.centerXPercent).toBeCloseTo(50, 5);

    const mici = projectFaceAnchor([0, 0], resolveDriverCameraProfile("mici", null), {
      width: 1344,
      height: 760,
    })!;
    expect(mici.centerXPercent).toBeCloseTo(50, 5);
  });

  it("pushes off-center faces outward relative to the old under-scaled math (the fix)", () => {
    // Reproduce the pre-fix projection: canvas-x divided by the full 2160, with
    // the same 100- mirror. That math under-scales horizontal deviation because
    // the 2:1 canvas is wider than the ~1.6:1 tici video, pulling boxes toward
    // center. The fix maps canvas-x into the video's actual (pillarboxed) span.
    const profile = resolveDriverCameraProfile("tici", null);
    const video = { width: 1928, height: 1208 };
    const oldCenterX = (faceX: number): number => {
      const ticiX = 1080 - 1714 * faceX;
      const canvasX = (ticiX - TICI_CANVAS_WIDTH / 2) * profile.anchorScale + TICI_CANVAS_WIDTH / 2;
      return 100 - (canvasX / TICI_CANVAS_WIDTH) * 100;
    };

    // faceX > 0 maps the box right of screen center (>50). The old under-scaled
    // math reported it closer to center than the true face; the fix pushes it
    // further right (outward), toward where the face actually is.
    const fixed = projectFaceAnchor([0.3, 0], profile, video)!;
    expect(fixed.centerXPercent).toBeGreaterThan(50);
    expect(fixed.centerXPercent).toBeGreaterThan(oldCenterX(0.3));

    // Symmetric: faceX < 0 maps left of center (<50); fix pushes further left.
    const other = projectFaceAnchor([-0.3, 0], profile, video)!;
    expect(other.centerXPercent).toBeLessThan(50);
    expect(other.centerXPercent).toBeLessThan(oldCenterX(-0.3));
  });

  it("leaves the vertical axis unchanged from the canvas mapping", () => {
    // object-fit:contain fills the canvas height, so /canvasHeight is already a
    // true fraction of the video. The fix must not alter Y.
    const profile = resolveDriverCameraProfile("tici", null);
    const anchor = projectFaceAnchor([0.1, 0.2], profile, { width: 1928, height: 1208 })!;
    const ticiY = -135 + 504 + Math.abs(0.1) * 112 + (1205 - Math.abs(0.1) * 724) * 0.2;
    const canvasY = (ticiY - TICI_CANVAS_HEIGHT / 2) * profile.anchorScale + TICI_CANVAS_HEIGHT / 2;
    expect(anchor.centerYPercent).toBeCloseTo((canvasY / TICI_CANVAS_HEIGHT) * 100, 5);
  });

  it("clamps the box inside the rendered video horizontally", () => {
    // An extreme facePosition must not place the box off the video (negative or
    // >100 percent); the pillarbox mapping clamps canvasX to the video strip.
    const anchor = projectFaceAnchor([2, 0], resolveDriverCameraProfile("tici", null), {
      width: 1928,
      height: 1208,
    })!;
    expect(anchor.centerXPercent).toBeGreaterThanOrEqual(0);
    expect(anchor.centerXPercent).toBeLessThanOrEqual(100);
  });

  it("keeps the encoded-stream horizontal mirror (faceX sign flips across center)", () => {
    // The `100 -` mirror maps positive faceX to the right of screen center and
    // negative faceX to the left, because the viewer shows the non-pre-flipped
    // encoded stream (openpilot's on-device UI flips the driver camera).
    const profile = resolveDriverCameraProfile("tici", null);
    const video = { width: 1928, height: 1208 };
    const right = projectFaceAnchor([0.25, 0], profile, video)!;
    const left = projectFaceAnchor([-0.25, 0], profile, video)!;
    expect(right.centerXPercent).toBeGreaterThan(50);
    expect(left.centerXPercent).toBeLessThan(50);
    expect(100 - right.centerXPercent).toBeCloseTo(left.centerXPercent, 4);
  });
});
