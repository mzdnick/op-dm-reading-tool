const ATHENA_BASE_URL = "https://athena.comma.ai";
const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_UPLOAD_FILES = 32;
const DONGLE_ID_PATTERN = /^[a-f0-9]{16}$/i;
const DRIVER_VIDEO_PATH_PATTERN = /^[a-z0-9_-]+--\d+\/dcamera\.hevc$/i;

export async function proxyAthenaUploadRequest(
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
  if (!isAllowedUploadPayload(payload)) {
    return jsonResponse({ error: "Only driver-video upload requests are allowed." }, 400);
  }

  const body = JSON.stringify(payload);
  if (body.length > MAX_REQUEST_BYTES) {
    return jsonResponse({ error: "Upload request is too large." }, 413);
  }

  try {
    const response = await fetcher(`${ATHENA_BASE_URL}/${dongleId}`, {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json",
      },
      body,
    });
    const responseBody = await response.arrayBuffer();
    return new Response(responseBody, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders(response.headers.get("Content-Type")),
    });
  } catch {
    return jsonResponse({ error: "Could not reach comma Athena." }, 502);
  }
}

function isAllowedUploadPayload(payload: unknown): payload is Record<string, unknown> {
  if (!isRecord(payload) || payload.jsonrpc !== "2.0" || payload.method !== "uploadFilesToUrls") return false;
  if (!isRecord(payload.params) || !Array.isArray(payload.params.files_data)) return false;
  const files = payload.params.files_data;
  if (files.length === 0 || files.length > MAX_UPLOAD_FILES) return false;
  return files.every((file) => {
    if (!isRecord(file) || typeof file.fn !== "string" || !DRIVER_VIDEO_PATH_PATTERN.test(file.fn)) return false;
    if (typeof file.url !== "string" || !isHttpsUrl(file.url)) return false;
    return file.allow_cellular === false && isRecord(file.headers);
  });
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
