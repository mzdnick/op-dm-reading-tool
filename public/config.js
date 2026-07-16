/*
 * op-dm-reading-tool-stable runtime backend config.
 *
 * This file is served as-is and sets which Comma Connect (or clone) backend
 * the app talks to. Edit it (or replace it at deploy time) — no rebuild needed.
 *
 * Pick one of these strategies:
 *
 *   1. Use a built-in profile by id:
 *        window.OPDM_BACKEND = { backend: "konik" };   // or "comma"
 *
 *   2. Point at any Comma-compatible host (jwt auth, self-hosted uploads):
 *        window.OPDM_BACKEND = { api: "https://api.example.com",
 *                                athena: "https://api.example.com/ws" };
 *
 *   3. Leave it unset (or delete this file) to default to comma.
 *
 * A visitor can always override per-visit with ?backend=konik or ?api=<host>.
 */
window.OPDM_BACKEND = { backend: "comma" };
