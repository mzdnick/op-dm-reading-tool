import { describe, expect, it } from "vitest";
import type { DriverModelSample, DriverMonitoringSample } from "./dm";
import { buildMonitoringTimelineGradient, buildOnDeviceAlertMarkers, monitoringTimelineNote, monitoringTimelineState } from "./timeline";

const sample = (routeSeconds: number, overrides: Partial<DriverMonitoringSample> = {}): DriverMonitoringSample => ({
  logMonoTime: BigInt(routeSeconds * 1e9),
  routeSeconds,
  schema: "modern",
  alertLevel: "none",
  activePolicy: "vision",
  lockout: false,
  alwaysOnLockout: false,
  isRhd: false,
  faceDetected: true,
  isDistracted: false,
  distractedTypes: [],
  awareness: 1,
  awarenessVision: 1,
  awarenessWheel: 1,
  awarenessStep: 0,
  fallbackPercent: 0,
  uncertainPercent: 0,
  posePitch: 0,
  poseYaw: 0,
  poseUncertainty: 0,
  poseCalibrated: true,
  pitchOffset: 0,
  pitchCalibratedPercent: 1,
  yawOffset: 0,
  yawCalibratedPercent: 1,
  ...overrides,
});

const model = (phoneProb: number): DriverModelSample => ({
  logMonoTime: 0n,
  routeSeconds: 0,
  wheelOnRightProb: 0,
  left: { phoneProb },
  right: { phoneProb: 0 },
} as DriverModelSample);

describe("driver monitoring timeline", () => {
  it("ranks degraded, distracted, and failing states", () => {
    expect(monitoringTimelineState(sample(0))).toBe("normal");
    expect(monitoringTimelineState(sample(0, { awareness: 0.7 }))).toBe("degraded");
    expect(monitoringTimelineState(sample(0), model(0.9))).toBe("suggestion");
    expect(monitoringTimelineState(sample(0, { isDistracted: true }))).toBe("warning");
    expect(monitoringTimelineState(sample(0, { alertLevel: "two" }))).toBe("warning");
    expect(monitoringTimelineState(sample(0, { lockout: true }))).toBe("critical");
  });

  it("builds hard color transitions across the clip", () => {
    const gradient = buildMonitoringTimelineGradient([
      sample(10),
      sample(12, { awareness: 0.7 }),
      sample(15, { isDistracted: true }),
      sample(18, { alertLevel: "three" }),
    ], 10, 20);

    expect(gradient).toContain("#33d17a 0.00%");
    expect(gradient).toContain("#e3d756 20.00%");
    expect(gradient).toContain("#e08546 50.00%");
    expect(gradient).toContain("#ff5f68 80.00%");
    expect(gradient).toContain("#ff5f68 100.00%");
  });

  it("distinguishes raw distraction from an escalated warning", () => {
    expect(monitoringTimelineNote([sample(0, { isDistracted: true })])).toContain("did not escalate");
    expect(monitoringTimelineNote([sample(0, { isDistracted: true, alertLevel: "two" })])).toContain("warning-level alert");
  });

  it("marks only actual on-device alert intervals", () => {
    expect(buildOnDeviceAlertMarkers([
      sample(10, { isDistracted: true }),
      sample(12, { alertLevel: "one" }),
      sample(14, { alertLevel: "two" }),
      sample(16, { alertLevel: "three" }),
      sample(18),
    ], 10, 20)).toEqual([
      { severity: "early", startPercent: 20, endPercent: 40 },
      { severity: "warning", startPercent: 40, endPercent: 60 },
      { severity: "critical", startPercent: 60, endPercent: 80 },
    ]);
  });
});
