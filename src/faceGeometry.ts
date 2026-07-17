import type { DeviceType } from "./capnp";

/**
 * Face-box projection.
 *
 * The green/orange boxes visualize `driverStateV2.DriverData.facePosition`.
 * openpilot places them on a 2160x1080 (2:1) "tici canvas" using the coarse
 * approximation:
 *
 *   tici_x = 1080 - 1714 * face_x
 *   tici_y = -135 + 504 + abs(face_x) * 112 + (1205 - abs(face_x) * 724) * face_y
 *
 * Those constants (1080, 1714, 504, 112, 1205, 724) are the model's coordinate
 * frame mapped to the tici sensor and must NOT be "cleaned up" — see
 * `.agents/skills/video-overlays/SKILL.md` and commit f813d68.
 *
 * The displayed driver video is narrower than 2:1 (tici 1928x1208 ~1.60:1,
 * mici 1344x760 ~1.77:1). Under object-fit:contain the video fills the canvas
 * height (so a /1080 y fraction is already a true fraction of the video) but is
 * pillarboxed horizontally. Dividing canvas-x by the full 2160 therefore
 * under-scales horizontal deviation and pulls every box toward horizontal
 * center. We undo that pillarbox so the box's x is a true fraction of the
 * rendered video width, while leaving the openpilot constants and the
 * `100 -` mirror (the encoded stream is not pre-flipped, unlike the on-device
 * UI) untouched.
 */

export const TICI_CANVAS_WIDTH = 2160;
export const TICI_CANVAS_HEIGHT = 1080;

export interface VideoDimensions {
  width: number;
  height: number;
}

export interface DriverCameraProfile {
  name: "tici" | "mici";
  /** openpilot scales the offset from canvas center by 1.25 for mici. */
  anchorScale: number;
}

export interface FaceAnchor {
  centerXPercent: number;
  centerYPercent: number;
}

/**
 * Prefer the device identity logged by openpilot. Stream dimensions are a
 * fallback for clips whose qlogs omit initData/deviceState.
 */
export function resolveDriverCameraProfile(
  deviceType: DeviceType | string | null | undefined,
  video: VideoDimensions | null,
): DriverCameraProfile {
  const isMici = String(deviceType ?? "").toLowerCase() === "mici"
    || (video?.width === 1344 && video?.height === 760);
  return isMici ? { name: "mici", anchorScale: 1.25 } : { name: "tici", anchorScale: 1 };
}

/**
 * Project a facePosition onto the displayed video, in CSS percent of the
 * rendered picture. centerXPercent is mirrored relative to the model frame so
 * it matches the non-pre-flipped encoded stream this viewer shows.
 */
export function projectFaceAnchor(
  facePosition: readonly number[],
  profile: DriverCameraProfile,
  video: VideoDimensions | null,
): FaceAnchor | null {
  if (facePosition.length < 2) return null;
  const [faceX, faceY] = facePosition;
  if (!Number.isFinite(faceX) || !Number.isFinite(faceY)) return null;

  const ticiX = 1080 - 1714 * faceX;
  const ticiY = -135 + 504 + Math.abs(faceX) * 112 + (1205 - Math.abs(faceX) * 724) * faceY;

  // Anchor-scaled canvas coordinates (openpilot scales mici offsets 1.25x
  // about the canvas center).
  const canvasX = (ticiX - TICI_CANVAS_WIDTH / 2) * profile.anchorScale + TICI_CANVAS_WIDTH / 2;
  const canvasY = (ticiY - TICI_CANVAS_HEIGHT / 2) * profile.anchorScale + TICI_CANVAS_HEIGHT / 2;

  // Y fills the canvas height under object-fit:contain, so /canvasHeight is
  // already a true fraction of the rendered video.
  const centerYPercent = (canvasY / TICI_CANVAS_HEIGHT) * 100;

  // X is pillarboxed: the video occupies a centered horizontal strip of width
  // videoCanvasWidth = videoW * (canvasHeight / videoH). Map canvasX into that
  // strip, then express it as a fraction of the strip width. Without this the
  // x fraction is taken against the full 2160, under-scaling horizontal
  // deviation and pulling boxes toward horizontal center.
  const centerXPercent = (() => {
    const videoAspect = video && video.height > 0 ? video.width / video.height : TICI_CANVAS_WIDTH / TICI_CANVAS_HEIGHT;
    const videoCanvasWidth = Math.min(TICI_CANVAS_WIDTH, TICI_CANVAS_HEIGHT * videoAspect);
    if (videoCanvasWidth <= 0) return 100 - (canvasX / TICI_CANVAS_WIDTH) * 100;
    const left = (TICI_CANVAS_WIDTH - videoCanvasWidth) / 2;
    const clampedX = Math.max(left, Math.min(left + videoCanvasWidth, canvasX));
    const fraction = (clampedX - left) / videoCanvasWidth;
    // Mirror: the encoded driver stream is not pre-flipped, unlike openpilot's
    // on-device UI, so x runs the opposite way relative to the viewer.
    return 100 - fraction * 100;
  })();

  return { centerXPercent, centerYPercent };
}
