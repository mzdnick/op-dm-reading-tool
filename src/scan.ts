import { findCalibrationMessages, type CalibrationMessage } from "./capnp";
import { decompressLog } from "./decompress";
import { isInvalidCalibration } from "./format";
import { fetchRouteFiles, fetchRouteInfo, logSourceLabel, orderedLogUrls, parseRouteInput, segmentFromUrl, type RouteInfo } from "./routes";

export interface ScanProgress {
  phase: "metadata" | "download" | "decode" | "done";
  message: string;
  current?: number;
  total?: number;
}

export interface CalibrationScanResult {
  routeName: string;
  routeInfo: RouteInfo | null;
  logUrl: string | null;
  logSource: "qlogs" | "rlogs";
  segment: number | null;
  message: CalibrationMessage | null;
  previousValid: CalibrationScanMessage | null;
  scannedSegments: number;
  totalSegments: number;
  scanMode: "quick" | "full";
  resultType: "invalid" | "valid";
  reason: "status-invalid" | "outside-current-limits" | "no-invalid-found" | "first-valid";
}

export interface CalibrationScanMessage {
  logUrl: string;
  segment: number;
  message: CalibrationMessage;
}

interface RouteLogContext {
  routeName: string;
  routeInfo: RouteInfo | null;
  logUrls: string[];
  source: "qlogs" | "rlogs";
}

export async function scanRouteForFirstValidCalibration(
  input: string,
  onProgress: (progress: ScanProgress) => void,
): Promise<CalibrationScanResult> {
  const context = await loadRouteLogContext(input, onProgress);

  for (let index = 0; index < context.logUrls.length; index += 1) {
    const logUrl = context.logUrls[index];
    const segment = segmentFromUrl(logUrl);
    const calibrationMessages = await downloadCalibrationMessages(logUrl, segment, index, context.logUrls.length, context.source, onProgress);
    const message = calibrationMessages.find((calibration) => calibration.status === 1 && calibration.rpyCalib.length === 3);
    if (message) {
      onProgress({ phase: "done", message: `Found valid calibration in segment ${segment}` });
      return {
        routeName: context.routeName,
        routeInfo: context.routeInfo,
        logUrl,
        logSource: context.source,
        segment,
        message,
        previousValid: null,
        scannedSegments: index + 1,
        totalSegments: context.logUrls.length,
        scanMode: "quick",
        resultType: "valid",
        reason: "first-valid",
      };
    }
  }

  throw new Error(`Scanned ${context.logUrls.length} uploaded ${logFileKind(context.source)} segment(s), but found no valid liveCalibration messages.`);
}

export async function scanRouteForInvalidCalibration(
  input: string,
  onProgress: (progress: ScanProgress) => void,
): Promise<CalibrationScanResult> {
  const context = await loadRouteLogContext(input, onProgress);
  let firstValid: CalibrationScanMessage | null = null;
  let lastValid: CalibrationScanMessage | null = null;

  for (let index = 0; index < context.logUrls.length; index += 1) {
    const logUrl = context.logUrls[index];
    const segment = segmentFromUrl(logUrl);
    const calibrationMessages = await downloadCalibrationMessages(logUrl, segment, index, context.logUrls.length, context.source, onProgress);
    const message = calibrationMessages.find((calibration) => isInvalidCalibration(calibration, context.routeInfo));
    if (message) {
      const reason = message.status === 2 ? "status-invalid" : "outside-current-limits";
      const sameSegmentPreviousValid = calibrationMessages
        .filter((calibration) => calibration.status === 1 && calibration.logMonoTime < message.logMonoTime)
        .at(-1);
      onProgress({ phase: "done", message: `Found invalid calibration in segment ${segment}` });
      return {
        routeName: context.routeName,
        routeInfo: context.routeInfo,
        logUrl,
        logSource: context.source,
        segment,
        message,
        previousValid: sameSegmentPreviousValid ? { logUrl, segment, message: sameSegmentPreviousValid } : lastValid,
        scannedSegments: index + 1,
        totalSegments: context.logUrls.length,
        scanMode: "full",
        resultType: "invalid",
        reason,
      };
    }
    const validMessages = calibrationMessages.filter((calibration) => calibration.status === 1);
    if (validMessages.length > 0) {
      const validScans = validMessages.map((validMessage) => ({ logUrl, segment, message: validMessage }));
      firstValid ??= validScans[0];
      lastValid = validScans.at(-1) ?? lastValid;
    }
  }

  if (firstValid) {
    onProgress({ phase: "done", message: `No invalid calibration found in ${context.logUrls.length} ${logFileKind(context.source)} segment(s).` });
    return {
      routeName: context.routeName,
      routeInfo: context.routeInfo,
      logUrl: firstValid.logUrl,
      logSource: context.source,
      segment: firstValid.segment,
      message: firstValid.message,
      previousValid: null,
      scannedSegments: context.logUrls.length,
      totalSegments: context.logUrls.length,
      scanMode: "full",
      resultType: "valid",
      reason: "no-invalid-found",
    };
  }

  throw new Error(`Scanned ${context.logUrls.length} uploaded ${logFileKind(context.source)} segment(s), but found no invalid or valid liveCalibration messages.`);
}

async function loadRouteLogContext(
  input: string,
  onProgress: (progress: ScanProgress) => void,
): Promise<RouteLogContext> {
  const parsed = parseRouteInput(input);
  onProgress({ phase: "metadata", message: `Reading file list for ${parsed.routeName}` });

  const [routeInfo, files] = await Promise.all([fetchRouteInfo(parsed.routeName), fetchRouteFiles(parsed.routeName)]);
  const logUrls = orderedLogUrls(files);
  if (logUrls.length === 0) {
    throw new Error("No qlogs or rlogs are uploaded for this route.");
  }
  const source = logSourceLabel(files);
  if (source === "none") {
    throw new Error("No qlogs or rlogs are uploaded for this route.");
  }
  if (source === "rlogs") {
    onProgress({ phase: "metadata", message: "No qlogs found; falling back to rlogs." });
  }

  return { routeName: parsed.routeName, routeInfo, logUrls, source };
}

async function downloadCalibrationMessages(
  logUrl: string,
  segment: number,
  index: number,
  total: number,
  source: "qlogs" | "rlogs",
  onProgress: (progress: ScanProgress) => void,
): Promise<CalibrationMessage[]> {
  onProgress({
    phase: "download",
    message: `Downloading ${logFileKind(source)} segment ${segment} (${index + 1}/${total})`,
    current: index + 1,
    total,
  });

  const compressed = new Uint8Array(await (await fetchLog(logUrl)).arrayBuffer());
  onProgress({
    phase: "decode",
    message: `Decoding segment ${segment}`,
    current: index + 1,
    total,
  });

  const decompressed = decompressLog(compressed, logUrl);
  return findCalibrationMessages(decompressed, (calibration) => calibration.rpyCalib.length === 3);
}

async function fetchLog(logUrl: string): Promise<Response> {
  const response = await fetch(logUrl);
  if (!response.ok) {
    throw new Error(`Could not download ${logUrl.split("?", 1)[0]} (${response.status}).`);
  }
  return response;
}

function logFileKind(source: "qlogs" | "rlogs"): "qlog" | "rlog" {
  return source === "qlogs" ? "qlog" : "rlog";
}
