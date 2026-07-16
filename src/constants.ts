import { getBackend } from "./backend";

/** REST API origin for the active backend (e.g. "https://api.comma.ai"). */
export const API_BASE_URL = getBackend().apiBaseUrl;
