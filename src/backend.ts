import { DEFAULT_BACKEND_ID, findBackend } from "./backends/registry";
import type { BackendConfig } from "./backends/types";

/**
 * The active backend is resolved once per page load, in priority order:
 *
 *  1. `?backend=<id>`    — override the profile per-visit (power users)
 *  2. `?api=<origin>`    — ad-hoc override pointing at any Comma-compatible host
 *  3. `window.OPDM_BACKEND` — set by the deployable public/config.js (see README)
 *  4. the default profile (`comma`)
 *
 * A `?api=` override derives a self-hosted backend from the supplied origin,
 * reusing Comma's path conventions and Athena path. `?athena=` may accompany it
 * to point Athena elsewhere (e.g. Konik's `/ws` path on a different host).
 */
export interface OpdmRuntimeConfig {
  backend?: string;
  api?: string;
  athena?: string;
}

declare global {
  // eslint-disable-next-line no-var
  var OPDM_BACKEND: OpdmRuntimeConfig | undefined;
}

let resolved: BackendConfig | null = null;

/** Returns the active backend profile, resolving it on first use. */
export function getBackend(): BackendConfig {
  if (resolved) return resolved;
  resolved = resolveBackend();
  return resolved;
}

/** Exposed for tests so the cached resolution can be reset between cases. */
export function resetBackendForTesting(): void {
  resolved = null;
}

function resolveBackend(): BackendConfig {
  const runtime = typeof window !== "undefined" ? window.OPDM_BACKEND : undefined;

  // Query params always override the deploy-time config.js so a visitor can
  // force a backend per-visit regardless of how the site is deployed.
  // 1a. ?backend=<id>
  const queryBackend = findBackend(readQuery("backend"));
  if (queryBackend) return queryBackend;

  // 1b. ?api=<origin>  (ad-hoc; optionally with ?athena=<origin>)
  const queryApi = readQuery("api");
  if (queryApi) {
    return deriveBackendFromApi(queryApi, readQuery("athena"));
  }

  // 2. window.OPDM_BACKEND set by config.js — backend id, then api origin.
  const byId = findBackend(runtime?.backend);
  if (byId) return byId;
  if (runtime?.api) {
    return deriveBackendFromApi(runtime.api, runtime.athena);
  }

  // 3. default
  return findBackend(DEFAULT_BACKEND_ID)!;
}

/** Builds a minimal jwt-mode backend from a bare API origin (the ?api= case). */
function deriveBackendFromApi(apiOrigin: string, athenaOrigin?: string | null): BackendConfig {
  const normalizedApi = apiOrigin.replace(/\/+$/, "");
  const host = hostOf(normalizedApi);
  // A self-hosted clone authenticates with its own JWT and serves its own
  // /connectincoming upload endpoints. The connect-style frontend is assumed to
  // live on the same host (overridable later if a clone splits them).
  return {
    id: host || "custom",
    label: host ? `${host} (custom)` : "Custom backend",
    apiBaseUrl: normalizedApi,
    athenaBaseUrl: (athenaOrigin?.replace(/\/+$/, "")) ?? `${normalizedApi}/ws`,
    connectFrontendUrl: normalizedApi,
    authMethod: "jwt",
    uploadAuth: {
      header: "Authorization",
      value: "JWT {jwt}",
      contentType: "application/octet-stream",
    },
  };
}

function readQuery(name: "backend" | "api" | "athena"): string | null {
  if (typeof window === "undefined" || !window.location?.search) return null;
  const value = new URLSearchParams(window.location.search).get(name);
  return value && value.trim() ? value.trim() : null;
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).hostname;
  } catch {
    return "";
  }
}
