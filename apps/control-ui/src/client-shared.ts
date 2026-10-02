/**
 * Single source of truth for the small pure helpers that both the server-rendered
 * dashboard (index.ts) and the emitted browser client (client.ts) need.
 *
 * The typed functions below are imported directly by index.ts and by tests;
 * `sharedClientSource()` serializes the identical logic into the inline client
 * script, so the shipped browser behavior cannot drift from the tested surface.
 * This mirrors redaction.ts / redactionClientSource().
 */

/** Exponential backoff for EventSource reconnect: 1s, 2s, 4s, 8s, 16s, then 30s cap. */
export function nextSseReconnectDelayMs(attempt: number): number {
  const n = Number.isFinite(attempt) ? Math.max(0, Math.floor(attempt)) : 0;
  return Math.min(30_000, 1_000 * 2 ** Math.min(n, 5));
}

/** High/critical risk (elevated require_approval) needs a second confirm before POST. */
export function isElevatedApprovalRisk(risk: string): boolean {
  const normalized = String(risk ?? "")
    .trim()
    .toLowerCase();
  return normalized === "high" || normalized === "critical";
}

/** Short prefix of an action hash for confirm dialog copy (full hash stays on the button). */
export function approvalActionHashPrefix(hash: string, maxLen = 12): string {
  const text = String(hash ?? "");
  if (!text) return "";
  return text.length > maxLen ? `${text.slice(0, maxLen)}…` : text;
}

/** Client-script definitions of `nextSseReconnectDelayMs`, `isElevatedApprovalRisk`, and `approvalActionHashPrefix`. */
export function sharedClientSource(): string {
  return `
function nextSseReconnectDelayMs(attempt) {
  const n = Number.isFinite(attempt) ? Math.max(0, Math.floor(attempt)) : 0;
  return Math.min(30000, 1000 * Math.pow(2, Math.min(n, 5)));
}
function isElevatedApprovalRisk(risk) {
  const normalized = String(risk || '').trim().toLowerCase();
  return normalized === 'high' || normalized === 'critical';
}
function approvalActionHashPrefix(hash, maxLen) {
  const text = String(hash || '');
  const limit = typeof maxLen === 'number' ? maxLen : 12;
  if (!text) return '';
  return text.length > limit ? text.slice(0, limit) + '\u2026' : text;
}
`;
}
