import type { DriverDebugSegment, DriverMonitoringSample } from "./dm";
import { segmentFromUrl } from "./routes";

export type FindingSeverity = "critical" | "warning" | "early" | "suggestion";

export interface ScanFinding {
  startSeconds: number;
  endSeconds: number;
  severity: FindingSeverity;
  title: string;
  reasons: string[];
  source: "connect" | "dm";
  dmConfirmed: boolean;
}

export interface ConnectRouteEvent {
  type?: string;
  route_offset_millis: number;
  route_offset_nanos?: number;
  data?: {
    alertStatus?: number | string;
  };
}

export interface SegmentScanResult {
  segment: number;
  findings: ScanFinding[];
  minimumAwareness: number;
  sampleCount: number;
}

export function buildConnectAlertIntervals(events: ConnectRouteEvent[], routeDurationMs: number): ScanFinding[] {
  const ordered = [...events].sort((a, b) =>
    a.route_offset_millis === b.route_offset_millis
      ? (a.route_offset_nanos ?? 0) - (b.route_offset_nanos ?? 0)
      : a.route_offset_millis - b.route_offset_millis,
  );
  const findings: ScanFinding[] = [];
  let active: { startMs: number; severity: "warning" | "critical" } | null = null;

  for (const event of ordered) {
    if (event.type !== "state" || event.data?.alertStatus === undefined) continue;
    const severity = connectAlertSeverity(event.data.alertStatus);
    if (active && severity !== active.severity) {
      findings.push(connectFinding(active.startMs, event.route_offset_millis, active.severity));
      active = null;
    }
    if (!active && severity) active = { startMs: event.route_offset_millis, severity };
  }
  if (active) findings.push(connectFinding(active.startMs, routeDurationMs, active.severity));
  return findings.filter((finding) => finding.endSeconds > finding.startSeconds);
}

export function prioritizeQlogUrls(urls: string[], connectFindings: ScanFinding[]): string[] {
  const priority = new Map<number, number>();
  for (const finding of connectFindings) {
    const rank = finding.severity === "critical" ? 0 : 1;
    const first = Math.max(0, Math.floor(finding.startSeconds / 60));
    const last = Math.max(first, Math.floor(Math.max(finding.startSeconds, finding.endSeconds - 0.001) / 60));
    for (let segment = first; segment <= last; segment += 1) {
      priority.set(segment, Math.min(priority.get(segment) ?? Number.MAX_SAFE_INTEGER, rank));
      if (segment > 0) priority.set(segment - 1, Math.min(priority.get(segment - 1) ?? Number.MAX_SAFE_INTEGER, rank + 2));
      priority.set(segment + 1, Math.min(priority.get(segment + 1) ?? Number.MAX_SAFE_INTEGER, rank + 2));
    }
  }
  return [...urls].sort((a, b) => {
    const aSegment = segmentFromUrl(a);
    const bSegment = segmentFromUrl(b);
    return (priority.get(aSegment) ?? 10) - (priority.get(bSegment) ?? 10) || aSegment - bSegment;
  });
}

export function summarizeDriverMonitoringSegment(decoded: DriverDebugSegment): SegmentScanResult {
  const monitoring = decoded.vehicles.length > 0
    ? decoded.monitoring.filter((sample) => vehicleEnabledAt(decoded, sample.routeSeconds))
    : decoded.monitoring;
  const findings = buildDmIntervals(monitoring);
  const minimum = monitoring.reduce<DriverMonitoringSample | null>(
    (lowest, sample) => lowest === null || sample.awareness < lowest.awareness ? sample : lowest,
    null,
  );

  if (findings.length === 0 && minimum && minimum.awareness < 0.8) {
    findings.push({
      startSeconds: Math.max(decoded.segment * 60, minimum.routeSeconds - 8),
      endSeconds: Math.min((decoded.segment + 1) * 60, minimum.routeSeconds + 8),
      severity: "suggestion",
      title: "Low awareness",
      reasons: [`minimum ${Math.round(minimum.awareness * 100)}%`],
      source: "dm",
      dmConfirmed: false,
    });
  }

  const isRhd = decoded.monitoring.find((sample) => sample.faceDetected)?.isRhd ?? decoded.monitoring[0]?.isRhd ?? false;
  const models = decoded.vehicles.length > 0
    ? decoded.models.filter((sample) => vehicleEnabledAt(decoded, sample.routeSeconds))
    : decoded.models;
  const phonePeak = models.reduce<{ probability: number; routeSeconds: number } | null>((peak, sample) => {
    const probability = (isRhd ? sample.right : sample.left).phoneProb;
    return peak === null || probability > peak.probability ? { probability, routeSeconds: sample.routeSeconds } : peak;
  }, null);
  if (phonePeak && phonePeak.probability >= 0.8 && !findings.some((finding) => overlapsTime(finding, phonePeak.routeSeconds))) {
    findings.push({
      startSeconds: Math.max(decoded.segment * 60, phonePeak.routeSeconds - 6),
      endSeconds: Math.min((decoded.segment + 1) * 60, phonePeak.routeSeconds + 6),
      severity: "suggestion",
      title: "Phone model peak",
      reasons: [`${Math.round(phonePeak.probability * 100)}% probability`],
      source: "dm",
      dmConfirmed: false,
    });
  }

  return {
    segment: decoded.segment,
    findings,
    minimumAwareness: minimum?.awareness ?? 1,
    sampleCount: decoded.monitoring.length,
  };
}

export function mergeScanFindings(findings: ScanFinding[]): ScanFinding[] {
  const ordered = [...findings].sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || a.startSeconds - b.startSeconds);
  const merged: ScanFinding[] = [];
  for (const finding of ordered) {
    const existing = merged.find((candidate) =>
      Math.max(candidate.startSeconds, finding.startSeconds) <= Math.min(candidate.endSeconds, finding.endSeconds) + 1,
    );
    if (!existing) {
      merged.push({ ...finding, reasons: [...finding.reasons] });
      continue;
    }
    existing.startSeconds = Math.min(existing.startSeconds, finding.startSeconds);
    existing.endSeconds = Math.max(existing.endSeconds, finding.endSeconds);
    if (severityRank(finding.severity) < severityRank(existing.severity)) {
      existing.severity = finding.severity;
      existing.title = finding.title;
    }
    if (finding.dmConfirmed && !existing.dmConfirmed) existing.title = finding.title;
    existing.dmConfirmed ||= finding.dmConfirmed;
    existing.reasons = [...new Set([...existing.reasons, ...finding.reasons])];
  }
  const definite = merged.filter((finding) => finding.severity !== "suggestion");
  const suggestions = merged
    .filter((finding) => finding.severity === "suggestion")
    .sort((a, b) => (b.endSeconds - b.startSeconds) - (a.endSeconds - a.startSeconds))
    .slice(0, 10);
  return [...definite, ...suggestions].sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || a.startSeconds - b.startSeconds);
}

function buildDmIntervals(samples: DriverMonitoringSample[]): ScanFinding[] {
  const findings: ScanFinding[] = [];
  let active: { start: number; last: number; severity: FindingSeverity; title: string; reasons: Set<string>; confirmed: boolean } | null = null;
  for (const sample of samples) {
    const state = sampleFindingState(sample);
    if (active && (!state || state.severity !== active.severity || sample.routeSeconds - active.last > 1.1)) {
      findings.push(dmFinding(active));
      active = null;
    }
    if (!state) continue;
    if (!active) {
      active = { start: sample.routeSeconds, last: sample.routeSeconds, ...state, reasons: new Set(state.reasons) };
    } else {
      active.last = sample.routeSeconds;
      state.reasons.forEach((reason) => active?.reasons.add(reason));
    }
  }
  if (active) findings.push(dmFinding(active));
  return findings.filter((finding) => finding.endSeconds - finding.startSeconds >= (finding.severity === "suggestion" ? 2 : 0));
}

function sampleFindingState(sample: DriverMonitoringSample): { severity: FindingSeverity; title: string; reasons: string[]; confirmed: boolean } | null {
  const reasons = sample.distractedTypes.length > 0 ? sample.distractedTypes : sample.faceDetected ? [] : ["face not detected"];
  if (sample.lockout || sample.alertLevel === "three") return { severity: "critical", title: sample.lockout ? "Driver Monitoring lockout" : "Critical DM alert", reasons, confirmed: true };
  if (sample.alertLevel === "two") return { severity: "warning", title: "DM warning", reasons, confirmed: true };
  if (sample.alertLevel === "one") return { severity: "early", title: "Early DM alert", reasons, confirmed: true };
  if (sample.isDistracted) return { severity: "suggestion", title: "Sustained distraction signal", reasons, confirmed: false };
  return null;
}

function dmFinding(active: { start: number; last: number; severity: FindingSeverity; title: string; reasons: Set<string>; confirmed: boolean }): ScanFinding {
  return {
    startSeconds: active.start,
    endSeconds: active.last + 0.5,
    severity: active.severity,
    title: active.title,
    reasons: [...active.reasons],
    source: "dm",
    dmConfirmed: active.confirmed,
  };
}

function connectAlertSeverity(value: number | string): "warning" | "critical" | null {
  if (value === 2 || value === "critical") return "critical";
  if (value === 1 || value === "userPrompt") return "warning";
  return null;
}

function connectFinding(startMs: number, endMs: number, severity: "warning" | "critical"): ScanFinding {
  return {
    startSeconds: startMs / 1000,
    endSeconds: endMs / 1000,
    severity,
    title: severity === "critical" ? "Critical system alert" : "Orange system warning",
    reasons: ["Connect timeline"],
    source: "connect",
    dmConfirmed: false,
  };
}

function severityRank(severity: FindingSeverity): number {
  return ({ critical: 0, warning: 1, early: 2, suggestion: 3 })[severity];
}

function overlapsTime(finding: ScanFinding, routeSeconds: number): boolean {
  return routeSeconds >= finding.startSeconds - 1 && routeSeconds <= finding.endSeconds + 1;
}

function vehicleEnabledAt(decoded: DriverDebugSegment, routeSeconds: number): boolean {
  let latest = decoded.vehicles[0];
  for (const sample of decoded.vehicles) {
    if (sample.routeSeconds > routeSeconds) break;
    latest = sample;
  }
  return latest?.enabled ?? false;
}
