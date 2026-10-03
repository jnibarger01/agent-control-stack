/**
 * Client attribution for the managed edge lanes (/mcp and /jc/mcp).
 *
 * The edge verifies the OAuth token, so `client_id` and `sub` are trustworthy. What an MCP client says about
 * itself (`initialize.clientInfo`, the User-Agent header) is NOT: it is passed to ACS as an unverified claim
 * for operators to read in Mission Control. Nothing here grants, widens or changes any authority, and nothing
 * here may delay or fail a request: reporting is fire-and-forget with a short timeout.
 */

import crypto from "node:crypto";

const PRINTABLE = /[^\x20-\x7e]/g;

/**
 * ACS accepts client ids up to 256 characters. A longer verified id (an HTTPS client-metadata URL can be)
 * must not be truncated: two ids sharing a 256-character prefix would collapse into one client, and
 * labelling one would admit the other. Send a collision-resistant digest of the full id instead.
 */
export function clientIdForAcs(clientId) {
  if (typeof clientId !== "string" || clientId.length === 0) return null;
  if (clientId.length <= 256) return clientId;
  return `sha256:${crypto.createHash("sha256").update(clientId).digest("hex")}`;
}

/** Bound and strip a self-declared string to printable ASCII. */
export function sanitizeClaim(value, max = 128) {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(PRINTABLE, "").trim().slice(0, max);
  return cleaned.length > 0 ? cleaned : undefined;
}

/** `{name, version}` from a parsed JSON-RPC `initialize`, or undefined. */
export function extractClientInfo(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || parsed.method !== "initialize")
    return undefined;
  const info = parsed.params && typeof parsed.params === "object" ? parsed.params.clientInfo : undefined;
  if (!info || typeof info !== "object") return undefined;
  const name = sanitizeClaim(info.name);
  const version = sanitizeClaim(info.version, 64);
  if (!name && !version) return undefined;
  return { ...(name ? { name } : {}), ...(version ? { version } : {}) };
}

/** Claims object -> the headers ACS reads. Empty when there is nothing to say. */
export function claimHeaders(claims) {
  const headers = {};
  const name = sanitizeClaim(claims && claims.name);
  const version = sanitizeClaim(claims && claims.version, 64);
  const userAgent = sanitizeClaim(claims && claims.userAgent, 200);
  if (name) headers["x-mcp-client-name"] = name;
  if (version) headers["x-mcp-client-version"] = version;
  if (userAgent) headers["x-mcp-user-agent"] = userAgent;
  return headers;
}

/** Small bounded TTL cache so a later tools/call can reuse the clientInfo from that client's initialize. */
export class ClientInfoCache {
  constructor({ max = 512, ttlMs = 24 * 60 * 60 * 1000, now = Date.now } = {}) {
    this.max = max;
    this.ttlMs = ttlMs;
    this.now = now;
    this.entries = new Map();
  }
  set(key, info) {
    if (!info) return;
    this.entries.delete(key);
    this.entries.set(key, { info, at: this.now() });
    while (this.entries.size > this.max) this.entries.delete(this.entries.keys().next().value);
  }
  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (this.now() - entry.at > this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.info;
  }
}

export const OBSERVED_METHODS = new Set(["initialize", "tools/list"]);

/**
 * Reports "this verified client just connected" to ACS. `post(path, body)` is injected so this module has
 * no dependency on the ACS transport. Never throws and never rejects; failures are counted, not surfaced.
 */
export function createClientObserver({
  post,
  throttleMs = 60_000,
  timeoutMs = 1_500,
  now = Date.now,
  onError = () => {}
}) {
  const last = new Map();
  const stats = { sent: 0, throttled: 0, failed: 0 };
  async function observe({ lane, identity, method, claims }) {
    try {
      if (!OBSERVED_METHODS.has(method)) return false;
      const clientId = identity && typeof identity.clientId === "string" ? identity.clientId : "";
      const subject = identity && typeof identity.subject === "string" ? identity.subject : "";
      if (!clientId || !subject) return false;
      const key = `${lane}|${clientId}|${subject}|${method}`;
      const t = now();
      const previous = last.get(key);
      if (previous !== undefined && t - previous < throttleMs) {
        stats.throttled += 1;
        return false;
      }
      last.set(key, t);
      if (last.size > 2_000) for (const [k, at] of last) if (t - at > throttleMs) last.delete(k);
      const bodyClaims = {};
      const name = sanitizeClaim(claims && claims.name);
      const version = sanitizeClaim(claims && claims.version, 64);
      const userAgent = sanitizeClaim(claims && claims.userAgent, 200);
      if (name) bodyClaims.name = name;
      if (version) bodyClaims.version = version;
      if (userAgent) bodyClaims.userAgent = userAgent;
      const payload = {
        lane,
        clientId,
        subject,
        method,
        ...(Object.keys(bodyClaims).length ? { claims: bodyClaims } : {})
      };
      const result = await Promise.race([
        post("/mcp-clients/observe", payload),
        new Promise((_, reject) => setTimeout(() => reject(new Error("observe timeout")), timeoutMs).unref())
      ]);
      if (result && typeof result.status === "number" && result.status >= 400)
        throw new Error(`acs_http_${result.status}`);
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
  return { observe, stats };
}
