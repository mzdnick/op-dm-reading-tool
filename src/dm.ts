import {
  readBool,
  readEventEnvelope,
  readFloat32,
  readFloatList,
  readInt32Slot,
  readInt8,
  readMessages,
  readStructField,
  readUint16Slot,
  readUint32,
  readUint64Slot,
  type StructRef,
} from "./capnp";

export const EVENT_TAGS = {
  carState: 21,
  driverCameraState: 68,
  driverMonitoringStateDeprecated: 69,
  driverEncodeIdx: 74,
  driverStateV2: 90,
  selfdriveState: 128,
  driverMonitoringState: 149,
} as const;

export interface DriverModelData {
  faceOrientation: number[];
  faceOrientationStd: number[];
  facePosition: number[];
  facePositionStd: number[];
  faceProb: number;
  leftEyeProb: number;
  rightEyeProb: number;
  leftBlinkProb: number;
  rightBlinkProb: number;
  sunglassesProb: number;
  phoneProb: number;
}

export interface DriverModelSample {
  logMonoTime: bigint;
  routeSeconds: number;
  wheelOnRightProb: number;
  modelExecutionTime: number;
  gpuExecutionTime: number;
  left: DriverModelData;
  right: DriverModelData;
}

export interface DriverMonitoringSample {
  logMonoTime: bigint;
  routeSeconds: number;
  schema: "modern" | "legacy";
  alertLevel: "none" | "one" | "two" | "three";
  activePolicy: "wheeltouch" | "vision";
  lockout: boolean;
  alwaysOnLockout: boolean;
  isRhd: boolean;
  faceDetected: boolean;
  isDistracted: boolean;
  distractedTypes: Array<"pose" | "eye" | "phone">;
  awareness: number;
  awarenessVision: number;
  awarenessWheel: number;
  awarenessStep: number;
  fallbackPercent: number;
  uncertainPercent: number;
  posePitch: number;
  poseYaw: number;
  poseUncertainty: number;
  poseCalibrated: boolean;
  pitchOffset: number;
  pitchCalibratedPercent: number;
  yawOffset: number;
  yawCalibratedPercent: number;
}

export interface VehicleSample {
  logMonoTime: bigint;
  routeSeconds: number;
  vEgo: number;
  gasPressed: boolean;
  steeringPressed: boolean;
  standstill: boolean;
  enabled: boolean;
}

export interface DriverVideoFrameIndex {
  logMonoTime: bigint;
  segment: number;
  presentationIndex: number;
  encodeIndex: number;
  frameId: number;
  timestampSof: bigint;
  timestampEof: bigint;
  byteOffset: number;
  byteLength: number;
  keyframe: boolean;
  routeSeconds: number;
  durationMs: number;
  compositionTimeOffsetMs: number;
}

export interface DriverDebugSegment {
  segment: number;
  monitoring: DriverMonitoringSample[];
  models: DriverModelSample[];
  vehicles: VehicleSample[];
  videoFrames: DriverVideoFrameIndex[];
}

interface TimedPayload {
  tag: number;
  logMonoTime: bigint;
  payload: StructRef;
}

export function decodeDriverDebugSegment(bytes: Uint8Array, segment: number): DriverDebugSegment {
  const events: TimedPayload[] = [];
  for (const message of readMessages(bytes)) {
    const event = readEventEnvelope(message);
    if (event?.payload) events.push({ tag: event.unionTag, logMonoTime: event.logMonoTime, payload: event.payload });
  }

  const encodeEvents = events.filter((event) => event.tag === EVENT_TAGS.driverEncodeIdx);
  const segmentBaseMono = encodeEvents.reduce<bigint | null>((minimum, event) => {
    const timestamp = readUint64Slot(event.payload, 3);
    return minimum === null || timestamp < minimum ? timestamp : minimum;
  }, null) ?? events[0]?.logMonoTime ?? 0n;
  const toRouteSeconds = (mono: bigint) => segment * 60 + Number(mono - segmentBaseMono) / 1e9;

  const monitoring = events.flatMap((event) => {
    if (event.tag === EVENT_TAGS.driverMonitoringState) {
      return [decodeModernMonitoring(event.payload, event.logMonoTime, toRouteSeconds(event.logMonoTime))];
    }
    if (event.tag === EVENT_TAGS.driverMonitoringStateDeprecated) {
      return [decodeLegacyMonitoring(event.payload, event.logMonoTime, toRouteSeconds(event.logMonoTime))];
    }
    return [];
  });

  const models = events
    .filter((event) => event.tag === EVENT_TAGS.driverStateV2)
    .map((event) => decodeDriverModel(event.payload, event.logMonoTime, toRouteSeconds(event.logMonoTime)));

  const carEvents = events.filter((event) => event.tag === EVENT_TAGS.carState);
  const selfdriveEvents = events.filter((event) => event.tag === EVENT_TAGS.selfdriveState);
  const vehicles = carEvents.map((event) => {
    const selfdrive = latestAtOrBefore(selfdriveEvents, event.logMonoTime);
    return {
      logMonoTime: event.logMonoTime,
      routeSeconds: toRouteSeconds(event.logMonoTime),
      vEgo: readFloat32(event.payload, 0),
      gasPressed: readBool(event.payload, 64),
      steeringPressed: readBool(event.payload, 66),
      standstill: readBool(event.payload, 67),
      enabled: readBool(selfdrive?.payload ?? null, 16),
    };
  });

  return {
    segment,
    monitoring,
    models,
    vehicles,
    videoFrames: decodeVideoFrames(encodeEvents, segment),
  };
}

function decodeModernMonitoring(payload: StructRef, logMonoTime: bigint, routeSeconds: number): DriverMonitoringSample {
  const vision = readStructField(payload, 1);
  const wheel = readStructField(payload, 2);
  const distracted = readStructField(vision, 0);
  const pose = readStructField(vision, 1);
  const pitchCalib = readStructField(pose, 0);
  const yawCalib = readStructField(pose, 1);
  const activePolicy = readUint16Slot(payload, 3) === 1 ? "vision" : "wheeltouch";
  const awarenessVision = readInt8(vision, 0) / 100;
  const awarenessWheel = readInt8(wheel, 0) / 100;
  return {
    logMonoTime,
    routeSeconds,
    schema: "modern",
    alertLevel: (["none", "one", "two", "three"] as const)[readUint16Slot(payload, 2)] ?? "none",
    activePolicy,
    lockout: readBool(payload, 0),
    alwaysOnLockout: readBool(payload, 2),
    isRhd: readBool(payload, 3),
    faceDetected: readBool(vision, 9),
    isDistracted: readBool(vision, 8),
    distractedTypes: (["pose", "eye", "phone"] as const).filter((_, index) => readBool(distracted, index)),
    awareness: activePolicy === "vision" ? awarenessVision : awarenessWheel,
    awarenessVision,
    awarenessWheel,
    awarenessStep: readFloat32(activePolicy === "vision" ? vision : wheel, 1),
    fallbackPercent: readInt8(vision, 2),
    uncertainPercent: readInt8(vision, 3),
    posePitch: readFloat32(pose, 0),
    poseYaw: readFloat32(pose, 1),
    poseUncertainty: readFloat32(pose, 3),
    poseCalibrated: readBool(pose, 64),
    pitchOffset: readFloat32(pitchCalib, 1),
    pitchCalibratedPercent: readInt8(pitchCalib, 0),
    yawOffset: readFloat32(yawCalib, 1),
    yawCalibratedPercent: readInt8(yawCalib, 0),
  };
}

function decodeLegacyMonitoring(payload: StructRef, logMonoTime: bigint, routeSeconds: number): DriverMonitoringSample {
  const distractedType = readUint32(payload, 10);
  return {
    logMonoTime,
    routeSeconds,
    schema: "legacy",
    alertLevel: "none",
    activePolicy: readBool(payload, 6) ? "vision" : "wheeltouch",
    lockout: false,
    alwaysOnLockout: false,
    isRhd: readBool(payload, 2),
    faceDetected: readBool(payload, 0),
    isDistracted: readBool(payload, 1),
    distractedTypes: distractedType === 0 ? [] : ["pose"],
    awareness: readFloat32(payload, 1),
    awarenessVision: readFloat32(payload, 7),
    awarenessWheel: readFloat32(payload, 8),
    awarenessStep: readFloat32(payload, 6),
    fallbackPercent: readUint32(payload, 9),
    uncertainPercent: readUint32(payload, 11),
    posePitch: 0,
    poseYaw: 0,
    poseUncertainty: readBool(payload, 4) ? 0 : 1,
    poseCalibrated: readBool(payload, 4),
    pitchOffset: readFloat32(payload, 2),
    pitchCalibratedPercent: readUint32(payload, 3),
    yawOffset: readFloat32(payload, 4),
    yawCalibratedPercent: readUint32(payload, 5),
  };
}

function decodeDriverModel(payload: StructRef, logMonoTime: bigint, routeSeconds: number): DriverModelSample {
  return {
    logMonoTime,
    routeSeconds,
    modelExecutionTime: readFloat32(payload, 1),
    wheelOnRightProb: readFloat32(payload, 4),
    gpuExecutionTime: readFloat32(payload, 5),
    left: decodeDriverData(readStructField(payload, 1)),
    right: decodeDriverData(readStructField(payload, 2)),
  };
}

function decodeDriverData(payload: StructRef | null): DriverModelData {
  return {
    faceOrientation: readFloatList(payload, 0),
    faceOrientationStd: readFloatList(payload, 1),
    facePosition: readFloatList(payload, 2),
    facePositionStd: readFloatList(payload, 3),
    faceProb: readFloat32(payload, 0),
    leftEyeProb: readFloat32(payload, 1),
    rightEyeProb: readFloat32(payload, 2),
    leftBlinkProb: readFloat32(payload, 3),
    rightBlinkProb: readFloat32(payload, 4),
    sunglassesProb: readFloat32(payload, 5),
    phoneProb: readFloat32(payload, 7),
  };
}

function decodeVideoFrames(events: TimedPayload[], segment: number): DriverVideoFrameIndex[] {
  const encoded = events.map((event, eventIndex) => ({
    event,
    frameId: readUint32(event.payload, 0),
    presentationIndex: readUint32(event.payload, 4),
    encodeIndex: readUint32(event.payload, 5) || eventIndex,
    timestampSof: readUint64Slot(event.payload, 3),
    timestampEof: readUint64Slot(event.payload, 4),
    flags: readUint32(event.payload, 10),
    byteLength: readUint32(event.payload, 11),
  })).sort((a, b) => a.encodeIndex - b.encodeIndex);

  let byteOffset = 0;
  const firstTimestamp = encoded[0]?.timestampSof ?? 0n;
  const byPresentation = [...encoded].sort((a, b) => a.presentationIndex - b.presentationIndex);
  const durationByPresentation = new Map<number, number>();
  for (let index = 0; index < byPresentation.length; index += 1) {
    const current = byPresentation[index];
    const next = byPresentation[index + 1];
    const duration = next ? Number(next.timestampSof - current.timestampSof) / 1e6 : 50;
    durationByPresentation.set(current.presentationIndex, Math.max(1, Math.min(1000, duration)));
  }

  return encoded.map((frame) => {
    const result: DriverVideoFrameIndex = {
      logMonoTime: frame.event.logMonoTime,
      segment,
      presentationIndex: frame.presentationIndex,
      encodeIndex: frame.encodeIndex,
      frameId: frame.frameId,
      timestampSof: frame.timestampSof,
      timestampEof: frame.timestampEof,
      byteOffset,
      byteLength: frame.byteLength,
      // openpilot's encoder flag set uses bit 3 for an IDR/keyframe. Bit 4 is
      // present on ordinary frames, so AV_PKT_FLAG_KEY's usual bit 0 is not
      // sufficient for these logs.
      keyframe: (frame.flags & 8) !== 0,
      routeSeconds: segment * 60 + Number(frame.timestampSof - firstTimestamp) / 1e9,
      durationMs: durationByPresentation.get(frame.presentationIndex) ?? 50,
      compositionTimeOffsetMs: (frame.presentationIndex - frame.encodeIndex) * 50,
    };
    byteOffset += frame.byteLength;
    return result;
  });
}

function latestAtOrBefore<T extends { logMonoTime: bigint }>(samples: T[], time: bigint): T | undefined {
  let latest: T | undefined;
  for (const sample of samples) {
    if (sample.logMonoTime > time) break;
    latest = sample;
  }
  return latest;
}

export function sampleAt<T extends { routeSeconds: number }>(samples: T[], routeSeconds: number): T | null {
  let latest: T | null = null;
  for (const sample of samples) {
    if (sample.routeSeconds > routeSeconds) break;
    latest = sample;
  }
  return latest;
}

export function selectDriver(model: DriverModelSample | null, monitoring: DriverMonitoringSample | null): {
  selected: DriverModelData | null;
  other: DriverModelData | null;
  side: "left" | "right";
} {
  if (!model) return { selected: null, other: null, side: monitoring?.isRhd ? "right" : "left" };
  const right = monitoring?.isRhd ?? model.wheelOnRightProb > 0.5;
  return right
    ? { selected: model.right, other: model.left, side: "right" }
    : { selected: model.left, other: model.right, side: "left" };
}
