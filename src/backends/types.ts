/**
 * Describes how file-upload payloads are authenticated when a device uploads a
 * driver-video segment. Comma returns Azure Blob Storage PUT URLs that expect
 * `x-ms-blob-type: BlockBlob`; Comma Connect clones typically serve their own
 * `/connectincoming` endpoints and authenticate with the JWT header instead.
 */
export interface UploadAuthScheme {
  /** Header name sent on each uploaded file (e.g. "x-ms-blob-type" or "Authorization"). */
  header: string;
  /** Header value (e.g. "BlockBlob" or "JWT <token>"). Use "{jwt}" as a placeholder. */
  value: string;
  /** Optional Content-Type the device upload endpoint expects. */
  contentType?: string;
}

/**
 * A backend profile. Comma Connect and its clones share the same v1/v2 API
 * paths and the same `JWT` auth scheme, so a profile is mostly a set of hosts
 * plus the OAuth/upload specifics that differ between them.
 */
export interface BackendConfig {
  /** Stable id used in ?backend= and config.js (e.g. "comma", "konik"). */
  id: string;
  /** Human-readable label for the UI (e.g. "Comma Connect", "Konik Stable"). */
  label: string;
  /** REST API origin (e.g. "https://api.comma.ai"). */
  apiBaseUrl: string;
  /** Athena JSON-RPC origin (e.g. "https://athena.comma.ai", "https://api.konik.ai/ws"). */
  athenaBaseUrl: string;
  /** The connect-style frontend origin that route/clip URLs are copied from. */
  connectFrontendUrl: string;
  /** How this backend authenticates end users. */
  authMethod: "oauth" | "jwt";
  /** OAuth provider client ids, present only when authMethod is "oauth". */
  oauth?: {
    googleClientId: string;
    githubClientId: string;
    appleClientId: string;
  };
  /** Upload auth scheme used when requesting driver-video uploads. */
  uploadAuth: UploadAuthScheme;
  /** Where a user can obtain a JWT for this backend (e.g. "https://jwt.comma.ai"). */
  tokenHelpUrl?: string;
}
