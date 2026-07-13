import { sampleAt, selectDriver, type DriverModelSample, type DriverMonitoringSample } from "./dm";

export type MonitoringTimelineState = "normal" | "suggestion" | "degraded" | "warning" | "critical";

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
  return (Math.max(0, Math.min(1, (seconds - startSeconds) / duration)) * 100).toFixed(2);
}
