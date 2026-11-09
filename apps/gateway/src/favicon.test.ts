import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { ACS_FAVICON_SVG, registerFaviconRoutes } from "./favicon.js";

describe("favicon routes", () => {
  it("serves the SVG icon at the gateway root without authentication", async () => {
    const app = Fastify({ logger: false });
    registerFaviconRoutes(app);
    const response = await app.inject({ method: "GET", url: "/favicon.svg" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("image/svg+xml");
    expect(response.headers["cache-control"]).toContain("max-age=604800");
    expect(response.body).toBe(ACS_FAVICON_SVG);
    expect(response.body).toContain("<svg");
    await app.close();
  });

  it("redirects the legacy .ico probe instead of returning 404", async () => {
    const app = Fastify({ logger: false });
    registerFaviconRoutes(app);
    const response = await app.inject({ method: "GET", url: "/favicon.ico" });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("/favicon.svg");
    await app.close();
  });
});
