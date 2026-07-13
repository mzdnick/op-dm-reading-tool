import { sampleAt, selectDriver, type DriverModelSample, type DriverMonitoringSample } from "./dm";

export type MonitoringTimelineState = "normal" | "suggestion" | "degraded" | "warning" | "critical";
export type OnDeviceAlertSeverity = "early" | "warning" | "critical";

export interface OnDeviceAlertMarker {
  severity: OnDeviceAlertSeverity;
  startPercent: number;
  endPercent: number;
}

export const MONITORING_TIMELINE_COLORS: Record<MonitoringTimelineState, string> = {
  normal: "#33d17a",
  suggestion: "#58b7ff",
  degraded: "#e3d756",
  warning: "#e08546",
  critical: "#ff5f68",
};

export function monitoringTimelineState(sample: DriverMonitoringSample, model: DriverModelSample | null = null): MonitoringTimelineState {
  if (sample.lockout || sample.alertLevel === "three" || sample.awareness <= 0) return "critical";
  if (sample.alertLevel === "two" || sample.isDistracted) return "warning";
  if (sample.alertLevel === "one" || sample.awareness < 0.8) return "degraded";
  if ((selectDriver(model, sample).selected?.phoneProb ?? 0) >= 0.8) return "suggestion";
  return "normal";
}

export function monitoringTimelineNote(samples: DriverMonitoringSample[]): string {
  const hasRawDistraction = samples.some((sample) => sample.isDistracted);
  const hasWarningOrFailure = samples.some((sample) => sample.lockout || sample.alertLevel === "two" || sample.alertLevel === "three");
  if (hasRawDistraction && !hasWarningOrFailure) {
    return "Orange in this clip marks brief raw distraction signals. openpilot did not escalate them to an on-device warning or failure.";
  }
  return "Orange can mean a raw distraction signal or a warning-level alert. Check the current alert state before treating it as an on-device warning.";
}

export function buildOnDeviceAlertMarkers(
  samples: DriverMonitoringSample[],
  startSeconds: number,
  endSeconds: number,
): OnDeviceAlertMarker[] {
  const duration = endSeconds - startSeconds;
  if (duration <= 0 || samples.length === 0) return [];
  const ordered = [...samples].sort((a, b) => a.routeSeconds - b.routeSeconds);
  const points: Array<{ seconds: number; sample: DriverMonitoringSample }> = [];
  const initial = sampleAt(ordered, startSeconds);
  if (initial) points.push({ seconds: startSeconds, sample: initial });
  for (const sample of ordered) {
    if (sample.routeSeconds < startSeconds || sample.routeSeconds >= endSeconds) continue;
    if (points.at(-1)?.seconds === sample.routeSeconds) points[points.length - 1] = { seconds: sample.routeSeconds, sample };
    else points.push({ seconds: sample.routeSeconds, sample });
  }

  const markers: OnDeviceAlertMarker[] = [];
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    const severity = onDeviceAlertSeverity(point.sample);
    if (!severity) continue;
    const nextSeconds = points[index + 1]?.seconds ?? endSeconds;
    const startPercent = percentAlongClipNumber(point.seconds, startSeconds, duration);
    const endPercent = percentAlongClipNumber(nextSeconds, startSeconds, duration);
    const previous = markers.at(-1);
    if (previous?.severity === severity && Math.abs(previous.endPercent - startPercent) < 0.01) previous.endPercent = endPercent;
    else markers.push({ severity, startPercent, endPercent });
  }
  return markers;
}

export function buildMonitoringTimelineGradient(
  samples: DriverMonitoringSample[],
  startSeconds: number,
  endSeconds: number,
  models: DriverModelSample[] = [],
): string {
  const duration = endSeconds - startSeconds;
  if (duration <= 0 || samples.length === 0) return MONITORING_TIMELINE_COLORS.normal;
  const ordered = [...samples].sort((a, b) => a.routeSeconds - b.routeSeconds);
  const orderedModels = [...models].sort((a, b) => a.routeSeconds - b.routeSeconds);
  const initial = sampleAt(ordered, startSeconds) ?? ordered.find((sample) => sample.routeSeconds >= startSeconds) ?? ordered[0];
  const stateAt = (seconds: number): MonitoringTimelineState => monitoringTimelineState(
    sampleAt(ordered, seconds) ?? initial,
    sampleAt(orderedModels, seconds),
  );
  const transitions: Array<{ seconds: number; state: MonitoringTimelineState }> = [
    { seconds: startSeconds, state: stateAt(startSeconds) },
  ];

  const transitionSeconds = [...new Set([
    ...ordered.map((sample) => sample.routeSeconds),
    ...orderedModels.map((sample) => sample.routeSeconds),
  ])].filter((seconds) => seconds > startSeconds && seconds < endSeconds).sort((a, b) => a - b);
  for (const seconds of transitionSeconds) {
    const state = stateAt(seconds);
    if (transitions.at(-1)?.state !== state) transitions.push({ seconds, state });
  }

  const stops: string[] = [];
  for (let index = 0; index < transitions.length; index += 1) {
    const transition = transitions[index];
    const nextSeconds = transitions[index + 1]?.seconds ?? endSeconds;
    const from = percentAlongClip(transition.seconds, startSeconds, duration);
    const to = percentAlongClip(nextSeconds, startSeconds, duration);
    const color = MONITORING_TIMELINE_COLORS[transition.state];
    stops.push(`${color} ${from}%`, `${color} ${to}%`);
  }
  return `linear-gradient(to right, ${stops.join(", ")})`;
}

function percentAlongClip(seconds: number, startSeconds: number, duration: number): string {
  return percentAlongClipNumber(seconds, startSeconds, duration).toFixed(2);
}

function percentAlongClipNumber(seconds: number, startSeconds: number, duration: number): number {
  return Math.max(0, Math.min(1, (seconds - startSeconds) / duration)) * 100;
}

function onDeviceAlertSeverity(sample: DriverMonitoringSample): OnDeviceAlertSeverity | null {
  if (sample.lockout || sample.alwaysOnLockout || sample.alertLevel === "three") return "critical";
  if (sample.alertLevel === "two") return "warning";
  if (sample.alertLevel === "one") return "early";
  return null;
}
