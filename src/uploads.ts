import { authHeaders } from "./auth";
import { API_BASE_URL } from "./constants";
import { parseRouteInput } from "./routeInput";
import { segmentFromUrl, type RouteFiles } from "./routes";

const ATHENA_PROXY_BASE_URL = "/api/athena";
const UPLOAD_EXPIRY_SECONDS = 7 * 24 * 60 * 60;

export interface DriverVideoUploadRequest {
  dongleId: string;
  routeName: string;
  paths: string[];
  segments: number[];
}

export interface UploadWatchUpdate {
  message: string;
  progress?: number;
}

interface UploadUrl { url: string; }
interface AthenaResponse {
  error?: { code?: number; data?: { message?: string }; message?: string };
  offline?: boolean;
  result?: unknown;
}
interface UploadQueueItem {
  path: string;
  current: boolean;
  progress: number;
  retry_count: number;
  allow_cellular: boolean;
  priority: number;
}

export function buildDriverVideoUploadRequest(routeName: string, segments: number[]): DriverVideoUploadRequest {
  const parsed = parseRouteInput(routeName);
  const uniqueSegments = [...new Set(segments)].sort((a, b) => a - b);
  return {
    dongleId: parsed.dongleId,
    routeName: parsed.routeName,
    segments: uniqueSegments,
    paths: uniqueSegments.map((segment) => `${parsed.routeId}--${segment}/dcamera.hevc`),
  };
}

export async function queueDriverVideoUpload(
  request: DriverVideoUploadRequest,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const urlResponse = await fetcher(`${API_BASE_URL}/v1/${request.dongleId}/upload_urls/`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ paths: request.paths, expiry_days: 7 }),
  });
  if (!urlResponse.ok) {
    if (urlResponse.status === 401 || urlResponse.status === 403) {
      throw new Error("This JWT cannot request uploads for that device. The device owner must queue it.");
    }
    throw new Error(`Could not prepare driver-video uploads (${urlResponse.status}).`);
  }
  const uploadUrls = await urlResponse.json() as UploadUrl[];
  if (uploadUrls.length !== request.paths.length || uploadUrls.some((item) => !item.url)) {
    throw new Error("comma did not return an upload destination for every driver-video segment.");
  }

  const payload = {
    id: 0,
    jsonrpc: "2.0",
    method: "uploadFilesToUrls",
    params: {
      files_data: request.paths.map((path, index) => ({
        fn: path,
        url: uploadUrls[index].url,
        headers: { "x-ms-blob-type": "BlockBlob" },
        allow_cellular: false,
        priority: 0,
      })),
    },
    expiry: Math.floor(Date.now() / 1_000) + UPLOAD_EXPIRY_SECONDS,
  };
  let athenaResponse: Response;
  try {
    athenaResponse = await fetcher(`${ATHENA_PROXY_BASE_URL}/${request.dongleId}`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new Error("Could not reach the driver-video upload relay.");
  }
  if (athenaResponse.status === 401 || athenaResponse.status === 403) {
    throw new Error("This JWT cannot request uploads for that device. The device owner must queue it.");
  }
  if (!athenaResponse.ok) throw new Error(`Could not queue the device upload (${athenaResponse.status}).`);
  const result = await athenaResponse.json() as AthenaResponse;
  if (result.error) throw new Error(result.error.data?.message ?? result.error.message ?? "The device rejected the upload request.");
  const failed = isUploadResult(result.result) ? result.result.failed ?? [] : [];
  if (failed.some((path) => request.paths.includes(path))) {
    throw new Error("The device could not find the driver video. Recording was probably not enabled for this drive.");
  }
  return result.result === "Device offline, message queued"
    ? "Upload queued · waiting for the device to come online"
    : "Driver-video upload queued";
}

export async function watchDriverVideoUpload(
  request: DriverVideoUploadRequest,
  onUpdate: (update: UploadWatchUpdate) => void,
  signal: AbortSignal,
  options: { fetcher?: typeof fetch; pause?: (milliseconds: number, signal: AbortSignal) => Promise<void>; maxPolls?: number } = {},
): Promise<void> {
  const fetcher = options.fetcher ?? fetch;
  const pause = options.pause ?? abortablePause;
  const maxPolls = options.maxPolls ?? 450;
  let highestProgress = 0;
  for (let poll = 0; poll < maxPolls; poll += 1) {
    if (signal.aborted) throw new DOMException("Upload watch cancelled", "AbortError");
    let filesResponse: Response;
    try {
      filesResponse = await fetcher(`${API_BASE_URL}/v1/route/${encodeURIComponent(request.routeName)}/files`, {
        headers: authHeaders(),
        cache: "no-store",
      });
    } catch {
      onUpdate({ message: "Upload queued · comma connection unavailable, retrying…" });
      await pause(2_000, signal);
      continue;
    }
    if (filesResponse.status === 401 || filesResponse.status === 403) {
      throw new Error("The saved JWT can no longer watch this route.");
    }
    if (filesResponse.ok) {
      const files = await filesResponse.json() as RouteFiles;
      const uploaded = new Set((files.dcameras ?? []).map(segmentFromUrl));
      const complete = request.segments.filter((segment) => uploaded.has(segment)).length;
      if (complete === request.segments.length) return;
      const incompletePaths = request.paths.filter((_, index) => !uploaded.has(request.segments[index]));
      let queueResult: AthenaResponse | null = null;
      try {
        queueResult = await fetchUploadQueue(request, fetcher);
      } catch (error) {
        if (error instanceof UploadQueueAuthError) throw error;
      }
      const queueItems = Array.isArray(queueResult?.result)
        ? queueResult.result.filter(isUploadQueueItem)
        : [];
      const matchingItems = queueItems.filter((item) => incompletePaths.some((path) => matchesUploadPath(item.path, path)));
      const queuedProgress = incompletePaths.reduce((sum, path) => {
        const progress = matchingItems
          .filter((item) => matchesUploadPath(item.path, path))
          .reduce((maximum, item) => Math.max(maximum, clampProgress(item.progress)), 0);
        return sum + progress;
      }, 0);
      highestProgress = Math.max(highestProgress, (complete + queuedProgress) / request.segments.length);
      const percent = Math.round(highestProgress * 100);
      const offline = queueResult?.result === "Device offline, message queued";
      const active = matchingItems.some((item) => item.current);
      onUpdate({
        message: active
          ? `Uploading driver video · ${percent}%`
          : matchingItems.length > 0
            ? `Driver video queued on device · ${percent}%`
            : offline
              ? "Upload queued · waiting for the device to come online"
              : complete > 0
                ? `Processing driver video (${complete}/${request.segments.length} segments available)`
                : "Waiting for driver video from the device…",
        progress: highestProgress,
      });
    }
    await pause(2_000, signal);
  }
  throw new Error("The upload is still queued. Leave the device on Wi-Fi and reload this clip later.");
}

async function fetchUploadQueue(request: DriverVideoUploadRequest, fetcher: typeof fetch): Promise<AthenaResponse | null> {
  const response = await fetcher(`${ATHENA_PROXY_BASE_URL}/${request.dongleId}`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({
      id: 0,
      jsonrpc: "2.0",
      method: "listUploadQueue",
      params: { paths: request.paths },
    }),
  });
  if (response.status === 401 || response.status === 403) throw new UploadQueueAuthError();
  if (!response.ok) return null;
  return response.json() as Promise<AthenaResponse>;
}

class UploadQueueAuthError extends Error {
  constructor() {
    super("The saved JWT can no longer watch this device's upload queue.");
  }
}

function isUploadQueueItem(value: unknown): value is UploadQueueItem {
  return typeof value === "object"
    && value !== null
    && typeof (value as UploadQueueItem).path === "string"
    && typeof (value as UploadQueueItem).progress === "number";
}

function matchesUploadPath(candidate: string, requested: string): boolean {
  return candidate === requested || candidate.endsWith(`/${requested}`);
}

function clampProgress(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}

function isUploadResult(result: unknown): result is { failed?: string[] } {
  return typeof result === "object" && result !== null;
}

function abortablePause(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => { cleanup(); resolve(); }, milliseconds);
    const onAbort = () => {
      cleanup();
      reject(new DOMException("Upload watch cancelled", "AbortError"));
    };
    const cleanup = () => {
      window.clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
