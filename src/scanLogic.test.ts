import { describe, expect, it } from "vitest";
import type { DriverDebugSegment, DriverMonitoringSample } from "./dm";
import { buildConnectAlertIntervals, mergeScanFindings, prioritizeQlogUrls, summarizeDriverMonitoringSegment } from "./scanLogic";

describe("route scan prioritization", () => {
  it("turns Connect alert status changes into orange and red intervals", () => {
    const findings = buildConnectAlertIntervals([
      { type: "state", route_offset_millis: 10_000, data: { alertStatus: 0 } },
      { type: "state", route_offset_millis: 20_000, data: { alertStatus: 1 } },
      { type: "state", route_offset_millis: 24_000, data: { alertStatus: 2 } },
      { type: "state", route_offset_millis: 27_000, data: { alertStatus: 0 } },
    ], 60_000);

    expect(findings).toMatchObject([
      { startSeconds: 20, endSeconds: 24, severity: "warning" },
      { startSeconds: 24, endSeconds: 27, severity: "critical" },
    ]);
  });

  it("scans critical and orange qlog segments before ordinary segments", () => {
    const urls = [0, 1, 2, 3, 4].map((segment) => `https://example.test/route/${segment}/qlog.zst`);
    const ordered = prioritizeQlogUrls(urls, [{
      startSeconds: 125,
      endSeconds: 130,
      severity: "warning",
      title: "Orange system warning",
      reasons: [],
      source: "connect",
      dmConfirmed: false,
    }]);
    expect(ordered.map((url) => Number(url.match(/\/(\d+)\/qlog/)?.[1]))).toEqual([2, 1, 3, 0, 4]);
  });
});

describe("DM segment summaries", () => {
  it("creates a confirmed interval from a level-two DM alert", () => {
    const segment = fakeSegment([
      monitoring(12, "none", false),
      monitoring(12.5, "two", true, ["eye"]),
      monitoring(13, "two", true, ["eye", "phone"]),
      monitoring(13.5, "none", false),
    ]);
    const result = summarizeDriverMonitoringSegment(segment);
    expect(result.findings[0]).toMatchObject({
      startSeconds: 12.5,
      endSeconds: 13.5,
      severity: "warning",
      title: "DM warning",
      reasons: ["eye", "phone"],
      dmConfirmed: true,
    });
  });

  it("merges a Connect warning with its confirmed DM interval", () => {
    const merged = mergeScanFindings([
      { startSeconds: 12, endSeconds: 14, severity: "warning", title: "Orange system warning", reasons: ["Connect timeline"], source: "connect", dmConfirmed: false },
      { startSeconds: 12.5, endSeconds: 13.5, severity: "warning", title: "DM warning", reasons: ["eye"], source: "dm", dmConfirmed: true },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ title: "DM warning", dmConfirmed: true, reasons: ["Connect timeline", "eye"] });
  });
});

function fakeSegment(monitoringSamples: DriverMonitoringSample[]): DriverDebugSegment {
  return { segment: 0, deviceType: null, monitoring: monitoringSamples, models: [], vehicles: [], videoFrames: [] };
}

function monitoring(
  routeSeconds: number,
  alertLevel: DriverMonitoringSample["alertLevel"],
  isDistracted: boolean,
  distractedTypes: DriverMonitoringSample["distractedTypes"] = [],
): DriverMonitoringSample {
  return {
    logMonoTime: BigInt(Math.round(routeSeconds * 1e9)), routeSeconds, schema: "modern", alertLevel,
    activePolicy: "vision", lockout: false, alwaysOnLockout: false, isRhd: false, faceDetected: true,
    isDistracted, distractedTypes, awareness: alertLevel === "none" ? 1 : 0.4, awarenessVision: 1,
    awarenessWheel: 1, awarenessStep: 0, fallbackPercent: 0, uncertainPercent: 0, posePitch: 0,
    poseYaw: 0, poseUncertainty: 0, poseCalibrated: true, pitchOffset: 0, pitchCalibratedPercent: 1,
    yawOffset: 0, yawCalibratedPercent: 1,
  };
}
