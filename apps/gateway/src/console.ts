import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import { CONSOLE_ASSET_DIR } from "@agent-control-stack/control-ui";

/**
 * Serves the built Mission Control SPA under /console/*.
 *
 * The shell and its assets are static and carry no data; every data route the
 * SPA calls is still authenticated by the gateway (HttpOnly, SameSite=Strict
 * session cookie or bearer credential), so serving them without a session
 * discloses nothing and lets the SPA render its own sign-in view.
 *
 * The CSP forbids inline script/style and any third-party origin: the bundle
 * is a same-origin `<script type="module">`, and the SPA only talks to the
 * gateway that served it.
 */
export const CONSOLE_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'"
].join("; ");

const CONTENT_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2"
};

// Hashed bundle names only; no path separators, dotfiles or traversal are ever accepted.
const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function securityHeaders(reply: FastifyReply): FastifyReply {
  return reply
    .header("content-security-policy", CONSOLE_CSP)
    .header("x-content-type-options", "nosniff")
    .header("x-frame-options", "DENY")
    .header("referrer-policy", "no-referrer")
    .header("cross-origin-opener-policy", "same-origin")
    .header("permissions-policy", "camera=(), microphone=(), geolocation=()");
}

export interface ConsoleOptions {
  assetDir?: string;
}

export function registerConsole(app: FastifyInstance, options: ConsoleOptions = {}): void {
  const assetDir = options.assetDir ?? CONSOLE_ASSET_DIR;

  const notBuilt = (reply: FastifyReply) =>
    securityHeaders(reply)
      .code(503)
      .header("cache-control", "no-store")
      .send({ error: "control console is not built", code: "console_not_built" });

  app.get("/console", async (_request, reply) => reply.redirect("/console/overview", 302));

  app.get<{ Params: { file: string } }>("/console/assets/:file", async (request, reply) => {
    const { file } = request.params;
    if (!ASSET_NAME.test(file) || file === "index.html") return reply.code(404).send({ error: "not found" });
    try {
      const body = await readFile(join(assetDir, file));
      return securityHeaders(reply)
        .header("content-type", CONTENT_TYPES[extname(file)] ?? "application/octet-stream")
        .header("cache-control", "public, max-age=31536000, immutable")
        .send(body);
    } catch {
      return reply.code(404).send({ error: "not found" });
    }
  });

  // Every other /console/* path is a client-side route: serve the shell so deep links and refresh work.
  app.get("/console/*", async (_request, reply) => {
    try {
      const html = await readFile(join(assetDir, "index.html"));
      return securityHeaders(reply)
        .header("content-type", "text/html; charset=utf-8")
        .header("cache-control", "no-store")
        .send(html);
    } catch {
      return notBuilt(reply);
    }
  });
}
