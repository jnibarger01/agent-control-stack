import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";

/**
 * Flag-gated hosting for the React Mission Control app (apps/mission-control-web).
 *
 * The legacy console at `/` is untouched. The SPA is served from `/next/` only
 * when `ACS_MC_WEB=1` (or `enabled: true`), so rollback is unsetting the flag.
 * The shell and assets are static and carry no data; every data call the SPA
 * makes goes through the existing authenticated routes. A strict CSP is sent
 * with every response (the legacy inline-script page cannot adopt one).
 */
export interface MissionControlWebOptions {
  enabled?: boolean;
  distDir?: string;
}

export const MISSION_CONTROL_WEB_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'"
].join("; ");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8"
};

const RATE_LIMIT = { config: { rateLimit: { max: 600, timeWindow: "1 minute" } } } as const;

export function defaultMissionControlWebDist(): string {
  return fileURLToPath(new URL("../../mission-control-web/dist", import.meta.url));
}

export function missionControlWebEnabled(options: MissionControlWebOptions | undefined): boolean {
  return options?.enabled ?? process.env.ACS_MC_WEB === "1";
}

export function registerMissionControlWeb(app: FastifyInstance, options: MissionControlWebOptions | undefined): void {
  if (!missionControlWebEnabled(options)) return;
  const root = resolve(options?.distDir ?? defaultMissionControlWebDist());

  const securityHeaders = (reply: { header: (k: string, v: string) => unknown }) => {
    reply.header("content-security-policy", MISSION_CONTROL_WEB_CSP);
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    reply.header("referrer-policy", "no-referrer");
  };

  app.get("/next", RATE_LIMIT, async (_request, reply) => reply.redirect("/next/", 302));

  app.get("/next/*", RATE_LIMIT, async (request, reply) => {
    securityHeaders(reply);
    if (!existsSync(join(root, "index.html"))) {
      app.log.error({ root }, "mission control web is enabled but not built");
      return reply.code(503).type("application/json").send({ error: "mission_control_web_not_built" });
    }
    const requested = decodeURIComponent((request.params as { "*": string })["*"] ?? "");
    const candidate = resolve(root, requested === "" ? "index.html" : requested);
    // Contain to the dist directory; anything else is a 404, never a read.
    const contained = candidate === root || candidate.startsWith(root + sep);
    const isFile = contained && existsSync(candidate) && statSync(candidate).isFile();
    if (!isFile) {
      // Only extension-less paths fall back to the SPA shell (hash routing means this is rare);
      // missing assets must 404 rather than return HTML.
      if (extname(requested) !== "") return reply.code(404).send({ error: "not_found" });
    }
    const file = isFile ? candidate : join(root, "index.html");
    const hashedAsset = isFile && candidate.startsWith(join(root, "assets") + sep);
    reply.header("cache-control", hashedAsset ? "public, max-age=31536000, immutable" : "no-store");
    return reply.type(MIME[extname(file)] ?? "application/octet-stream").send(createReadStream(file));
  });
}
