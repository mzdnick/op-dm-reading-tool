import { findFirstCalibrationMessage, type CalibrationMessage } from "./capnp";
import { decompressLog } from "./decompress";
import { fetchRouteFiles, fetchRouteInfo, orderedLogUrls, parseRouteInput, segmentFromUrl, type RouteInfo } from "./routes";

export interface ScanProgress {
  phase: "metadata" | "download" | "decode" | "done";
  message: string;
  current?: number;
  total?: number;
}

export interface CalibrationScanResult {
  routeName: string;
  routeInfo: RouteInfo | null;
  logUrl: string;
  segment: number;
  message: CalibrationMessage;
  scannedSegments: number;
}

export async function scanRouteForCalibration(
  input: string,
  onProgress: (progress: ScanProgress) => void,
): Promise<CalibrationScanResult> {
  const parsed = parseRouteInput(input);
  onProgress({ phase: "metadata", message: `Reading file list for ${parsed.routeName}` });

  const [routeInfo, files] = await Promise.all([fetchRouteInfo(parsed.routeName), fetchRouteFiles(parsed.routeName)]);
  const logUrls = orderedLogUrls(files);
  if (logUrls.length === 0) {
    throw new Error("No qlogs or rlogs are uploaded for this route.");
  }

  for (let index = 0; index < logUrls.length; index += 1) {
    const logUrl = logUrls[index];
    const segment = segmentFromUrl(logUrl);
    onProgress({
      phase: "download",
      message: `Downloading segment ${segment} (${index + 1}/${logUrls.length})`,
      current: index + 1,
      total: logUrls.length,
    });

    const compressed = new Uint8Array(await (await fetchLog(logUrl)).arrayBuffer());
    onProgress({
      phase: "decode",
      message: `Decoding segment ${segment}`,
      current: index + 1,
      total: logUrls.length,
    });

    const decompressed = decompressLog(compressed, logUrl);
    const message = findFirstCalibrationMessage(decompressed);
    if (message) {
      onProgress({ phase: "done", message: `Found calibrated data in segment ${segment}` });
      return {
        routeName: parsed.routeName,
        routeInfo,
        logUrl,
        segment,
        message,
        scannedSegments: index + 1,
      };
    }
  }

  throw new Error(`Scanned ${logUrls.length} uploaded log segment(s), but no calibrated liveCalibration message was found.`);
}

async function fetchLog(logUrl: string): Promise<Response> {
  const response = await fetch(logUrl);
  if (!response.ok) {
    throw new Error(`Could not download ${logUrl.split("?", 1)[0]} (${response.status}).`);
  }
  return response;
}
