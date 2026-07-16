import type { DeviceType } from "./capnp";

export interface VideoDimensions {
  width: number;
  height: number;
}

export interface DriverCameraProfile {
  name: "mici" | "tici";
  anchorScale: number;
}

export type FaceRendererMode = "auto" | "dm-0.10.3" | "dm-0.11.1";

export interface FaceAnchor {
  centerXPercent: number;
  centerYPercent: number;
}

const TICI_CANVAS_WIDTH = 2160;
const TICI_CANVAS_HEIGHT = 1080;

/**
 * Prefer the device identity logged by openpilot. Stream dimensions are a
 * fallback for clips whose qlogs omit initData/deviceState.
 */
export function resolveDriverCameraProfile(
  deviceType: DeviceType | null,
  video: VideoDimensions | null,
): DriverCameraProfile {
  if (deviceType === "mici" || video?.width === 1344 && video.height === 760) {
    return { name: "mici", anchorScale: 1.25 };
  }
  return { name: "tici", anchorScale: 1 };
}

/**
 * Reproduces openpilot's coarse face-position approximation. openpilot flips
 * the driver stream in its UI; the web player shows the encoded stream, so X
 * is mirrored back here. Head orientation is deliberately not included:
 * openpilot uses facePosition alone to place its box.
 */
export function projectFaceAnchor(
  facePosition: number[],
  profile: DriverCameraProfile,
  faceOrientation: number[] = [],
  renderer: FaceRendererMode = "auto",
): FaceAnchor | null {
  if (facePosition.length < 2) return null;
  const [faceX, faceY] = facePosition;
  if (!Number.isFinite(faceX) || !Number.isFinite(faceY)) return null;

  const ticiX = 1080 - 1714 * faceX;
  const ticiY = -135 + 504 + Math.abs(faceX) * 112 + (1205 - Math.abs(faceX) * 724) * faceY;
  const projectedX = (ticiX - TICI_CANVAS_WIDTH / 2) * profile.anchorScale + TICI_CANVAS_WIDTH / 2;
  const projectedY = (ticiY - TICI_CANVAS_HEIGHT / 2) * profile.anchorScale + TICI_CANVAS_HEIGHT / 2;

  let centerXPercent = 100 - projectedX / TICI_CANVAS_WIDTH * 100;
  let centerYPercent = projectedY / TICI_CANVAS_HEIGHT * 100;

  // The newer compatibility profile follows the pose-aware debug renderer
  // inherited from op-replay-clipper. This is deliberately selectable: the
  // logged schema cannot prove which model a fork actually ran.
  if (renderer === "auto" || renderer === "dm-0.11.1") {
    const [pitch = 0, yaw = 0] = faceOrientation;
    centerXPercent += yaw * (profile.name === "mici" ? 5.5 : 4.5);
    centerYPercent += pitch * 4;
  }

  return { centerXPercent, centerYPercent };
}

export function parseFaceRendererMode(value: string | null): FaceRendererMode {
  return value === "dm-0.10.3" || value === "dm-0.11.1" ? value : "auto";
}
