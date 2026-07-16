import type { BackendConfig } from "./types";

/**
 * Built-in backend profiles. New Comma Connect clones are added here (or
 * contributed at runtime via window.OPDM_BACKEND). All profiles reuse the same
 * Comma-compatible v1/v2 API paths and JWT auth scheme.
 */
export const BUILTIN_BACKENDS: readonly BackendConfig[] = [
  {
    id: "comma",
    label: "Comma Connect",
    apiBaseUrl: "https://api.comma.ai",
    athenaBaseUrl: "https://athena.comma.ai",
    connectFrontendUrl: "https://connect.comma.ai",
    authMethod: "oauth",
    oauth: {
      googleClientId: "45471411055-ornt4svd2miog6dnopve7qtmh5mnu6id.apps.googleusercontent.com",
      githubClientId: "28c4ecb54bb7272cb5a4",
      appleClientId: "ai.comma.login",
    },
    uploadAuth: {
      // Comma hands back Azure Blob Storage PUT URLs.
      header: "x-ms-blob-type",
      value: "BlockBlob",
    },
    tokenHelpUrl: "https://jwt.comma.ai",
  },
  {
    id: "konik",
    label: "Konik Stable",
    apiBaseUrl: "https://api.konik.ai",
    athenaBaseUrl: "https://api.konik.ai/ws",
    connectFrontendUrl: "https://stable.konik.ai",
    authMethod: "jwt",
    // Konik serves its own /connectincoming PUT endpoints and authenticates
    // device uploads with the same JWT the user signed in with.
    uploadAuth: {
      header: "Authorization",
      value: "JWT {jwt}",
      contentType: "application/octet-stream",
    },
    tokenHelpUrl: "https://useradmin.konik.ai",
  },
];

/** Default backend when nothing is configured. */
export const DEFAULT_BACKEND_ID = "comma";

/** Look up a built-in profile by id. Returns undefined when not found. */
export function findBackend(id: string | null | undefined): BackendConfig | undefined {
  if (!id) return undefined;
  return BUILTIN_BACKENDS.find((backend) => backend.id === id);
}
