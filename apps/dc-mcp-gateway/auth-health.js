/**
 * Authentication health on the managed edge lanes: why a credential was refused, and what a refresh outcome means.
 *
 * Pure functions (no I/O, no clock, no globals) so the OAuth behaviour is unit-testable without booting server.js.
 * Nothing here grants authority. A reason is only ever used to (a) pick the RFC 6750 challenge and (b) tell ACS,
 * for Mission Control, that a client needs to reconnect.
 */
import crypto from "node:crypto";
import { sanitizeClaim } from "./client-attribution.js";

const equalSecrets = (a, b) => {
  if (typeof a !== "string" || typeof b !== "string" || a.length === 0 || b.length === 0) return false;
  const x = crypto.createHash("sha256").update(a).digest();
  const y = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(x, y);
};

/**
 * Classify the Authorization header of a request. `clientId`/`subject` are returned only when the HMAC signature
 * verified, so a forged or garbage token can never be attributed to (or flag) a real client.
 */
export function classifyBearer(header, { signingKey, issuer, resource, nowSec }) {
  const match = typeof header === "string" ? /^Bearer\s+(\S+)\s*$/i.exec(header) : null;
  if (!match) return { ok: false, reason: "missing" };
  const parts = match[1].split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) return { ok: false, reason: "malformed" };
  const [h, p, sig] = parts;
  let payload;
  try {
    const expected = crypto.createHmac("sha256", signingKey).update(`${h}.${p}`).digest("base64url");
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: "bad_signature" };
    payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
    if (!payload || typeof payload !== "object") return { ok: false, reason: "malformed" };
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const identity = {
    ...(typeof payload.client_id === "string" ? { clientId: payload.client_id } : {}),
    ...(typeof payload.sub === "string" ? { subject: payload.sub } : {})
  };
  if (typeof payload.exp !== "number") return { ok: false, reason: "malformed", ...identity };
  if (payload.exp < nowSec) return { ok: false, reason: "expired", ...identity };
  if (payload.iss !== issuer) return { ok: false, reason: "wrong_issuer", ...identity };
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(resource)) return { ok: false, reason: "wrong_audience", ...identity };
  return { ok: true, payload };
}

const DESCRIPTIONS = {
  expired: "the access token expired",
  wrong_audience: "the access token is for a different resource",
  wrong_issuer: "the access token was issued by a different server",
  bad_signature: "the access token is not valid",
  malformed: "the access token is not valid"
};

/**
 * RFC 6750 section 3.1: a request with no credential gets a bare challenge (no `error`) so the client starts a fresh
 * sign-in; a presented-but-unusable token gets `error="invalid_token"` so the client refreshes or reconnects.
 * The description is fixed text and never echoes token material.
 */
export function bearerChallenge(base, reason) {
  if (reason === "missing" || !DESCRIPTIONS[reason]) return base;
  return `${base}, error="invalid_token", error_description="${DESCRIPTIONS[reason]}"`;
}

/**
 * Decide what a presented refresh token means.
 *
 * Rotation is strict: a token that was already used is never accepted again, and nothing about a previous response is
 * ever stored or re-served (an earlier opt-in "idempotent retry" cached live tokens at rest and was removed).
 *
 * @returns {{ok:true, record:object} | {ok:false, reason:string, clientId?:string}}
 */
export function resolveRefresh(records, token, nowSec, options = {}) {
  // Own properties only: "__proto__" / "constructor" must not resolve to a record.
  const record = typeof token === "string" && Object.hasOwn(records, token) ? records[token] : undefined;
  if (!record || typeof record !== "object") return { ok: false, reason: "refresh_unknown" };
  const clientId = record.client_id;
  // RFC 6749 section 6: the token is bound to the client it was issued to. A different client_id is not an event about
  // the real client (anyone holding a token could send it), so it is rejected and left unattributed.
  if (typeof options.presentedClientId === "string" && options.presentedClientId !== clientId) {
    return { ok: false, reason: "client_mismatch" };
  }
  if (record.revoked) return { ok: false, reason: "revoked", clientId };
  if (typeof record.exp !== "number" || record.exp < nowSec) return { ok: false, reason: "refresh_expired", clientId };
  const confidential = typeof options.clientSecret === "string" && options.clientSecret.length > 0;
  if (confidential && !equalSecrets(options.clientSecret, options.presentedSecret)) {
    return { ok: false, reason: "invalid_client", clientId };
  }
  if (record.active) return { ok: true, record };
  // The token was already rotated. If its successor has itself been used, the client demonstrably holds and uses a
  // working credential, so this is a stale duplicate (a double-submitted refresh), not a lost authorization: refuse it,
  // but do not call it a problem with the client. If the successor is still unused we cannot tell a duplicate request
  // from a client that lost the response, so it stays `refresh_reused`.
  const successor = typeof record.successor === "string" && Object.hasOwn(records, record.successor) ? records[record.successor] : undefined;
  if (successor && successor.active === false) return { ok: false, reason: "refresh_superseded", clientId };
  return { ok: false, reason: "refresh_reused", clientId };
}

/** Failure reasons the edge may report to ACS. Anything else is dropped rather than guessed. */
export const REPORTABLE_FAILURES = new Set([
  "refresh_unknown",
  "refresh_expired",
  "refresh_reused",
  "revoked",
  "invalid_client",
  "temporarily_unavailable",
  "access_token_expired"
]);

/** Map an edge-side reason to the ACS auth-event vocabulary. `refresh_unknown` is ACS's `refresh_rejected`. */
export function acsReason(reason) {
  if (reason === "refresh_unknown") return "refresh_rejected";
  if (reason === "expired") return "access_token_expired";
  return reason;
}

/**
 * Reports authentication outcomes to ACS (`POST /mcp-clients/auth-event`). `post(path, body)` is injected.
 * Never throws or rejects, never delays a request (callers do not await it), and a failure only ever drops an event:
 * under-reporting can hide a problem for a while, but it can never invent a reauthentication requirement.
 * Disabled (a no-op) unless `enabled`. This is the only thing ACS_MCP_AUTH_EVENTS controls.
 */
export function createAuthEventReporter({ enabled = false, post, timeoutMs = 1_500, throttleMs = 60_000, now = Date.now, onError = () => {} }) {
  const last = new Map();
  const stats = { sent: 0, throttled: 0, failed: 0, disabled: 0 };
  async function report({ lane, identity, kind, reason, refreshExpiresAt }) {
    try {
      if (!enabled) {
        stats.disabled += 1;
        return false;
      }
      const clientId = identity && typeof identity.clientId === "string" ? identity.clientId : "";
      if (!clientId) return false;
      const subject = sanitizeClaim(identity.subject, 128);
      const mapped = reason ? acsReason(reason) : undefined;
      // Success is always worth sending; a repeated identical rejection is throttled.
      const key = `${lane}|${clientId}|${kind}|${mapped ?? ""}`;
      const t = now();
      if (kind === "token_rejected" || kind === "refresh_failed") {
        const previous = last.get(key);
        if (previous !== undefined && t - previous < throttleMs) {
          stats.throttled += 1;
          return false;
        }
        last.set(key, t);
        if (last.size > 2_000) for (const [k, at] of last) if (t - at > throttleMs) last.delete(k);
      }
      const payload = {
        lane,
        clientId,
        ...(subject ? { subject } : {}),
        kind,
        ...(mapped ? { reason: mapped } : {}),
        ...(refreshExpiresAt ? { refreshExpiresAt } : {})
      };
      const result = await Promise.race([
        post("/mcp-clients/auth-event", payload),
        new Promise((_, reject) => setTimeout(() => reject(new Error("auth-event timeout")), timeoutMs).unref())
      ]);
      if (result && typeof result.status === "number" && result.status >= 400) throw new Error(`acs_http_${result.status}`);
      stats.sent += 1;
      return true;
    } catch (error) {
      stats.failed += 1;
      try {
        onError(error);
      } catch {
        /* reporting must never throw */
      }
      return false;
    }
  }
  return { report, stats };
}
