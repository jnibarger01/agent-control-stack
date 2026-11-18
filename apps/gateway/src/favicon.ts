import type { FastifyInstance } from "fastify";

/**
 * The same mark the React Mission Control shell uses. It is served from the
 * gateway root so both `/` and `/next/` resolve the icon, and so browsers stop
 * probing `/favicon.ico` and logging a 404 on every page load.
 */
export const ACS_FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 42"><path fill="#6d8cff" d="M18 3a3 3 0 0 1 5 0l7 12H11z"/><path fill="#8b5cf6" d="M9 19h12L10 38H0z"/><path fill="#38bdf8" d="M24 19h8l8 19H30z"/></svg>`;

export const FAVICON_CACHE_CONTROL = "public, max-age=604800, immutable";

/**
 * Browsers that ignore `<link rel="icon">` still request `/favicon.ico`. A
 * redirect keeps that probe a success without maintaining a second raster
 * asset; the SVG is the canonical icon.
 */
export function registerFaviconRoutes(app: FastifyInstance): void {
  app.get("/favicon.svg", async (_request, reply) => {
    reply.header("cache-control", FAVICON_CACHE_CONTROL);
    reply.header("x-content-type-options", "nosniff");
    return reply.type("image/svg+xml; charset=utf-8").send(ACS_FAVICON_SVG);
  });

  app.get("/favicon.ico", async (_request, reply) => {
    reply.header("cache-control", FAVICON_CACHE_CONTROL);
    return reply.redirect("/favicon.svg", 302);
  });
}
