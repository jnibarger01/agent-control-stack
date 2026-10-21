import type { FastifyInstance } from "fastify";
import type { IncomingHttpHeaders } from "node:http";
import { cookies, sessionCookieName } from "./credentials.js";

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Defense in depth for cookie-authenticated writes. The session cookie is SameSite=Strict, which only
 * blocks cross-*site* requests: a page on another origin of the same site (another localhost port, a
 * sibling subdomain) still sends it, and a "simple" cross-origin form POST needs no preflight.
 *
 * So when a write is authenticated by the session cookie alone (no Authorization header), a browser
 * that declares the request is not same-origin is refused. Requests with a bearer token are
 * unaffected, and so are non-browser clients, which send neither header.
 */
export function isCrossOriginCookieWrite(method: string, headers: IncomingHttpHeaders): boolean {
  if (!UNSAFE_METHODS.has(method.toUpperCase())) return false;
  if (headers.authorization) return false;
  if (!cookies(typeof headers.cookie === "string" ? headers.cookie : undefined)[sessionCookieName]) return false;
  const fetchSite = headers["sec-fetch-site"];
  if (typeof fetchSite === "string") return fetchSite !== "same-origin" && fetchSite !== "none";
  const origin = headers.origin;
  if (typeof origin === "string") {
    try {
      return new URL(origin).host !== headers.host;
    } catch {
      return true;
    }
  }
  return false;
}

export function registerCsrfGuard(app: FastifyInstance): void {
  app.addHook("onRequest", async (request, reply) => {
    if (isCrossOriginCookieWrite(request.method, request.headers)) {
      return reply.code(403).send({ error: "cross-origin write refused", code: "csrf_origin_mismatch" });
    }
  });
}
