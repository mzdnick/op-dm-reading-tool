export const ROUTE_QUERY_PARAM = "route";

export interface ParsedRouteInput {
  routeName: string;
  dongleId: string;
  routeId: string;
  source: "route" | "connect-url";
  startSeconds: number;
  endSeconds: number;
  explicitClipRange: boolean;
}

export const DEFAULT_CLIP_START_SECONDS = 0;
export const DEFAULT_CLIP_END_SECONDS = 30;

export function parseRouteInput(input: string): ParsedRouteInput {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Paste a public comma Connect URL or route name first.");

  if (trimmed.startsWith("https://connect.comma.ai/")) {
    const url = new URL(trimmed);
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 2) {
      throw new Error("Connect URLs need at least /<dongle>/<route> in the path.");
    }
    const [dongleId, routeId] = parts;
    const startSeconds = parseClipSecond(parts[2], DEFAULT_CLIP_START_SECONDS);
    const endSeconds = parseClipSecond(parts[3], DEFAULT_CLIP_END_SECONDS);
    if (endSeconds <= startSeconds) throw new Error("Connect clip end must be after its start time.");
    return {
      routeName: `${dongleId}|${routeId}`,
      dongleId,
      routeId,
      source: "connect-url",
      startSeconds,
      endSeconds,
      explicitClipRange: parts.length >= 4,
    };
  }

  const routeName = trimmed.replace("/", "|");
  const [dongleId, routeId] = routeName.split("|");
  if (!dongleId || !routeId) {
    throw new Error("Route names should look like dongle_id|route_id.");
  }

  return {
    routeName,
    dongleId,
    routeId,
    source: "route",
    startSeconds: DEFAULT_CLIP_START_SECONDS,
    endSeconds: DEFAULT_CLIP_END_SECONDS,
    explicitClipRange: false,
  };
}

function parseClipSecond(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error("Connect clip times must be non-negative numbers.");
  return parsed;
}

export function routeInputFromUrl(urlLike: string | URL): string | null {
  const url = typeof urlLike === "string" ? new URL(urlLike, "https://example.test") : urlLike;
  const rawRoute = url.searchParams.get(ROUTE_QUERY_PARAM);
  if (!rawRoute?.trim()) return null;

  try {
    parseRouteInput(rawRoute);
    return rawRoute;
  } catch {
    return null;
  }
}

export function buildRouteShareUrl(origin: string, basePath: string, routeInput: string): string {
  parseRouteInput(routeInput);
  const url = new URL(basePath || "/", origin);
  url.searchParams.set(ROUTE_QUERY_PARAM, routeInput.trim());
  return url.toString();
}

export function buildAuthCallbackCleanUrl(currentHref: string, basePath: string): string {
  const currentUrl = new URL(currentHref);
  const cleanedUrl = new URL(basePath || "/", currentUrl.origin);
  const routeName = routeInputFromUrl(currentUrl);
  if (routeName) cleanedUrl.searchParams.set(ROUTE_QUERY_PARAM, routeName);
  return cleanedUrl.toString();
}
