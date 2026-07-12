import { fetchRouteFiles, fetchRouteInfo, parseRouteInput, segmentFromUrl } from "./routes";
import {
  buildConnectAlertIntervals,
  mergeScanFindings,
  prioritizeQlogUrls,
  type ConnectRouteEvent,
  type ScanFinding,
  type SegmentScanResult,
} from "./scanLogic";

export interface RouteScanUpdate {
  routeName: string;
  dongleId: string;
  routeId: string;
  findings: ScanFinding[];
  scannedSegments: number;
  totalSegments: number;
  failedSegments: number;
  phase: "events" | "qlogs" | "complete";
  message: string;
}

interface ScanTask {
  segment: number;
  url: string;
}

type WorkerResponse =
  | { id: number; ok: true; result: SegmentScanResult }
  | { id: number; ok: false; error: string };

export async function scanDriverMonitoringRoute(
  input: string,
  onUpdate: (update: RouteScanUpdate) => void,
  signal: AbortSignal,
): Promise<RouteScanUpdate> {
  const parsed = parseRouteInput(input);
  const [routeInfo, files] = await Promise.all([
    fetchRouteInfo(parsed.routeName),
    fetchRouteFiles(parsed.routeName),
  ]);
  throwIfAborted(signal);

  const qlogUrls = files.qlogs ?? [];
  if (qlogUrls.length === 0) throw new Error("No qlogs are uploaded for this route, so it cannot be scanned quickly.");
  const maxSegment = Math.max(routeInfo?.maxqlog ?? 0, ...qlogUrls.map(segmentFromUrl).filter(Number.isFinite));
  const routeDurationMs = Math.max(60_000, routeInfo?.duration ? routeInfo.duration * 1000 : (maxSegment + 1) * 60_000);

  let findings: ScanFinding[] = [];
  const baseUpdate = {
    routeName: parsed.routeName,
    dongleId: parsed.dongleId,
    routeId: parsed.routeId,
    totalSegments: qlogUrls.length,
    failedSegments: 0,
  };
  onUpdate({
    ...baseUpdate,
    findings,
    scannedSegments: 0,
    phase: "events",
    message: "Reading Connect timeline warnings",
  });

  if (routeInfo?.url) {
    const events = await fetchConnectEvents(routeInfo.url, maxSegment, signal);
    findings = buildConnectAlertIntervals(events, routeDurationMs);
  }
  throwIfAborted(signal);

  const prioritizedUrls = prioritizeQlogUrls(qlogUrls, findings);
  const tasks = prioritizedUrls.map((url) => ({ segment: segmentFromUrl(url), url }));
  let scannedSegments = 0;
  let failedSegments = 0;
  onUpdate({
    ...baseUpdate,
    findings,
    scannedSegments,
    failedSegments,
    phase: "qlogs",
    message: findings.length > 0
      ? `Found ${findings.length} Connect warning ${findings.length === 1 ? "interval" : "intervals"}; scanning those qlogs first`
      : "No Connect warnings found; scanning qlogs for DM signals",
  });

  await runScanPool(tasks, signal, (result) => {
    scannedSegments += 1;
    if (result) findings = mergeScanFindings([...findings, ...result.findings]);
    else failedSegments += 1;
    onUpdate({
      ...baseUpdate,
      findings,
      scannedSegments,
      failedSegments,
      phase: "qlogs",
      message: `Scanned ${scannedSegments} of ${tasks.length} qlog segments`,
    });
  });

  const complete: RouteScanUpdate = {
    ...baseUpdate,
    findings,
    scannedSegments,
    failedSegments,
    phase: "complete",
    message: findings.length > 0
      ? `Scan complete · ${findings.length} ${findings.length === 1 ? "area" : "areas"} worth reviewing`
      : "Scan complete · no DM alerts or unusual signals found",
  };
  onUpdate(complete);
  return complete;
}

async function fetchConnectEvents(baseUrl: string, maxSegment: number, signal: AbortSignal): Promise<ConnectRouteEvent[]> {
  const requests = Array.from({ length: maxSegment + 1 }, async (_, segment) => {
    try {
      const response = await fetch(`${baseUrl}/${segment}/events.json`, { signal });
      if (!response.ok) return [];
      return await response.json() as ConnectRouteEvent[];
    } catch (error) {
      if (signal.aborted) throw error;
      return [];
    }
  });
  return (await Promise.all(requests)).flat();
}

async function runScanPool(
  tasks: ScanTask[],
  signal: AbortSignal,
  onResult: (result: SegmentScanResult | null) => void,
): Promise<void> {
  const hardwareConcurrency = typeof navigator === "undefined" ? 2 : navigator.hardwareConcurrency || 2;
  const workerCount = Math.min(tasks.length, Math.max(1, Math.min(2, hardwareConcurrency - 1)));
  const workers = Array.from({ length: workerCount }, () => new Worker(new URL("./scan.worker.ts", import.meta.url), { type: "module" }));
  let cursor = 0;
  let requestId = 0;

  const abort = () => workers.forEach((worker) => worker.terminate());
  signal.addEventListener("abort", abort, { once: true });
  try {
    await Promise.all(workers.map(async (worker) => {
      while (!signal.aborted) {
        const task = tasks[cursor];
        cursor += 1;
        if (!task) return;
        const result = await runWorkerTask(worker, task, requestId, signal);
        requestId += 1;
        onResult(result);
      }
    }));
    throwIfAborted(signal);
  } finally {
    signal.removeEventListener("abort", abort);
    workers.forEach((worker) => worker.terminate());
  }
}

function runWorkerTask(worker: Worker, task: ScanTask, id: number, signal: AbortSignal): Promise<SegmentScanResult | null> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    const onMessage = (event: MessageEvent<WorkerResponse>) => {
      if (event.data.id !== id) return;
      cleanup();
      resolve(event.data.ok ? event.data.result : null);
    };
    const onError = () => {
      cleanup();
      resolve(null);
    };
    const onAbort = () => {
      cleanup();
      reject(new DOMException("Scan cancelled", "AbortError"));
    };
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
    worker.postMessage({ id, segment: task.segment, url: task.url });
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("Scan cancelled", "AbortError");
}
