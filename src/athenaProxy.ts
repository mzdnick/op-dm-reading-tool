import { findBackend, DEFAULT_BACKEND_ID } from "./backends/registry";

const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_UPLOAD_FILES = 32;
const DONGLE_ID_PATTERN = /^[a-f0-9]{16}$/i;
const DRIVER_VIDEO_PATH_PATTERN = /^[a-z0-9_-]+--\d+\/dcamera\.hevc$/i;
/** Header the client sends to tell the relay which backend to forward to. */
const BACKEND_HEADER = "X-Opdm-Backend";

type AllowedAthenaRequest =
  | { kind: "upload"; outbound: Record<string, unknown> }
  | { kind: "queue"; outbound: Record<string, unknown>; paths: string[] };

export async function proxyAthenaRequest(
  request: Request,
  dongleId: string,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed." }, 405, { Allow: "POST" });
  }
  if (!DONGLE_ID_PATTERN.test(dongleId)) {
    return jsonResponse({ error: "Invalid device ID." }, 400);
  }

  const authorization = request.headers.get("Authorization");
  if (!authorization || !/^JWT\s+\S+$/i.test(authorization)) {
    return jsonResponse({ error: "A comma JWT is required." }, 401);
  }

  // Resolve the Athena target from the backend id the client sent. Unknown ids
  // (including a "?api=" custom host, which the relay cannot resolve to a known
  // Athena URL) are rejected so the relay never forwards to an arbitrary host.
  const backendId = request.headers.get(BACKEND_HEADER) ?? DEFAULT_BACKEND_ID;
  const backend = findBackend(backendId);
  if (!backend) {
    return jsonResponse({ error: "Unknown backend." }, 400);
  }
  const athenaBaseUrl = backend.athenaBaseUrl;

  const contentLength = Number(request.headers.get("Content-Length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    return jsonResponse({ error: "Upload request is too large." }, 413);
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ error: "Upload request must be valid JSON." }, 400);
  }
  const allowed = allowedAthenaRequest(payload);
  if (!allowed) {
    return jsonResponse({ error: "Only driver-video upload and progress requests are allowed." }, 400);
  }

  const body = JSON.stringify(allowed.outbound);
  if (body.length > MAX_REQUEST_BYTES) {
    return jsonResponse({ error: "Upload request is too large." }, 413);
  }

  try {
    const response = await fetcher(`${athenaBaseUrl}/${dongleId}`, {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json",
      },
      body,
    });
    if (allowed.kind === "queue" && response.ok) {
      const queuePayload = await response.json() as unknown;
      return sanitizedQueueResponse(queuePayload, allowed.paths, response.status);
    }
    const responseBody = await response.arrayBuffer();
    return new Response(responseBody, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders(response.headers.get("Content-Type")),
    });
  } catch {
    return jsonResponse({ error: `Could not reach ${backend.label} Athena.` }, 502);
  }
}

function allowedAthenaRequest(payload: unknown): AllowedAthenaRequest | null {
  if (!isRecord(payload) || payload.jsonrpc !== "2.0") return null;
  if (payload.method === "listUploadQueue") {
    if (!isRecord(payload.params) || !isDriverVideoPaths(payload.params.paths)) return null;
    return {
      kind: "queue",
      paths: payload.params.paths,
      outbound: { id: payload.id ?? 0, jsonrpc: "2.0", method: "listUploadQueue" },
    };
  }
  if (payload.method !== "uploadFilesToUrls") return null;
  if (!isRecord(payload.params) || !Array.isArray(payload.params.files_data)) return null;
  const files = payload.params.files_data;
  if (files.length === 0 || files.length > MAX_UPLOAD_FILES) return null;
  const valid = files.every((file) => {
    if (!isRecord(file) || typeof file.fn !== "string" || !DRIVER_VIDEO_PATH_PATTERN.test(file.fn)) return false;
    if (typeof file.url !== "string" || !isHttpsUrl(file.url)) return false;
    return file.allow_cellular === false && isRecord(file.headers);
  });
  return valid ? { kind: "upload", outbound: payload } : null;
}

function isDriverVideoPaths(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.length > 0
    && value.length <= MAX_UPLOAD_FILES
    && value.every((path) => typeof path === "string" && DRIVER_VIDEO_PATH_PATTERN.test(path));
}

function sanitizedQueueResponse(payload: unknown, requestedPaths: string[], status: number): Response {
  if (!isRecord(payload)) return jsonResponse({ error: "comma Athena returned an invalid queue response." }, 502);
  if (!Array.isArray(payload.result)) {
    const result = typeof payload.result === "string" ? payload.result : [];
    return jsonResponse({ id: payload.id ?? 0, jsonrpc: "2.0", result }, status);
  }
  const result = payload.result.flatMap((item) => {
    if (!isRecord(item) || typeof item.path !== "string") return [];
    const itemPath = item.path;
    if (!requestedPaths.some((path) => matchesPath(itemPath, path))) return [];
    return [{
      path: itemPath,
      current: item.current === true,
      progress: clampProgress(item.progress),
      retry_count: finiteNumber(item.retry_count),
      allow_cellular: item.allow_cellular === true,
      priority: finiteNumber(item.priority),
    }];
  });
  return jsonResponse({ id: payload.id ?? 0, jsonrpc: "2.0", result }, status);
}

function matchesPath(candidate: string, requested: string): boolean {
  return candidate === requested || candidate.endsWith(`/${requested}`);
}

function clampProgress(value: unknown): number {
  return Math.min(1, Math.max(0, finiteNumber(value)));
}

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function jsonResponse(body: unknown, status: number, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...responseHeaders("application/json; charset=utf-8"), ...headers },
  });
}

function responseHeaders(contentType: string | null): HeadersInit {
  return {
    "Cache-Control": "no-store",
    "Content-Type": contentType ?? "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  };
}
