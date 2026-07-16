import { getBackend } from "./backend";

export const ROUTE_QUERY_PARAM = "route";
export const ROUTE_TIME_QUERY_PARAM = "t";

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

/**
 * Hosts whose `https://<host>/...` URLs are accepted as connect-style clip
 * links. Always includes comma (so shared links work no matter the active
 * backend), plus the active backend's own connect frontend.
 */
function acceptedConnectHosts(): string[] {
  const hosts = new Set<string>(["connect.comma.ai"]);
  const frontend = getBackend().connectFrontendUrl;
  try {
    hosts.add(new URL(frontend).hostname);
  } catch {
    /* ignore malformed */
  }
  return [...hosts];
}

export function parseRouteInput(input: string): ParsedRouteInput {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Paste a Connect URL or route name first.");

  if (trimmed.startsWith("https://")) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      url = undefined as unknown as URL;
    }
    if (url && acceptedConnectHosts().includes(url.hostname)) {
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

export function routeTimeFromUrl(urlLike: string | URL): number | null {
  const url = typeof urlLike === "string" ? new URL(urlLike, "https://example.test") : urlLike;
  const rawTime = url.searchParams.get(ROUTE_TIME_QUERY_PARAM);
  if (rawTime === null || rawTime.trim() === "") return null;
  const routeSeconds = Number(rawTime);
  return Number.isFinite(routeSeconds) && routeSeconds >= 0 ? routeSeconds : null;
}

export function buildRouteShareUrl(origin: string, basePath: string, routeInput: string): string {
  parseRouteInput(routeInput);
  const url = new URL(basePath || "/", origin);
  url.searchParams.set(ROUTE_QUERY_PARAM, routeInput.trim());
  return url.toString();
}

export function buildRouteTimeUrl(currentHref: string, routeSeconds: number): string {
  if (!Number.isFinite(routeSeconds) || routeSeconds < 0) throw new Error("Route time must be a non-negative number.");
  const url = new URL(currentHref);
  url.searchParams.set(ROUTE_TIME_QUERY_PARAM, String(Math.floor(routeSeconds)));
  return url.toString();
}

export function buildAuthCallbackCleanUrl(currentHref: string, basePath: string): string {
  const currentUrl = new URL(currentHref);
  const cleanedUrl = new URL(basePath || "/", currentUrl.origin);
  const routeName = routeInputFromUrl(currentUrl);
  if (routeName) cleanedUrl.searchParams.set(ROUTE_QUERY_PARAM, routeName);
  const routeSeconds = routeTimeFromUrl(currentUrl);
  if (routeSeconds !== null) cleanedUrl.searchParams.set(ROUTE_TIME_QUERY_PARAM, String(Math.floor(routeSeconds)));
  return cleanedUrl.toString();
}
