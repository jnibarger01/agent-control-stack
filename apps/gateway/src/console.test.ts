import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { CONSOLE_CSP, registerConsole } from "./console.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function app(files: Record<string, string> | undefined) {
  const dir = await mkdtemp(join(tmpdir(), "acs-console-"));
  if (files) {
    await mkdir(dir, { recursive: true });
    for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), content);
  }
  const instance = Fastify();
  registerConsole(instance, { assetDir: files ? dir : join(dir, "missing") });
  await instance.ready();
  cleanups.push(async () => {
    await instance.close();
    await rm(dir, { recursive: true, force: true });
  });
  return instance;
}

const BUILT = {
  "index.html": "<!doctype html><title>ACS Mission Control</title>",
  "console-ABC123.js": "console.log(1)",
  "console-ABC123.css": "body{}"
};

describe("/console static serving", () => {
  it("serves the SPA shell for every client route so deep links and refresh work", async () => {
    const server = await app(BUILT);
    for (const url of [
      "/console/overview",
      "/console/work/WI-1837",
      "/console/audit/evt_1?severity=error",
      "/console/anything/else"
    ]) {
      const res = await server.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(200);
      expect(res.headers["content-type"]).toContain("text/html");
      expect(res.body).toContain("ACS Mission Control");
    }
  });

  it("redirects the bare /console entry to Overview", async () => {
    const res = await (await app(BUILT)).inject({ method: "GET", url: "/console" });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/console/overview");
  });

  it("sends a strict CSP and hardening headers on the shell and on assets", async () => {
    const server = await app(BUILT);
    for (const url of ["/console/overview", "/console/assets/console-ABC123.js"]) {
      const res = await server.inject({ method: "GET", url });
      expect(res.headers["content-security-policy"], url).toBe(CONSOLE_CSP);
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["x-frame-options"]).toBe("DENY");
      expect(res.headers["referrer-policy"]).toBe("no-referrer");
    }
    expect(CONSOLE_CSP).toMatch(/default-src 'none'/);
    expect(CONSOLE_CSP).toMatch(/script-src 'self'(;|$)/);
    expect(CONSOLE_CSP).not.toMatch(/unsafe-inline|unsafe-eval|\*/);
    expect(CONSOLE_CSP).toMatch(/frame-ancestors 'none'/);
  });

  it("the shell is never cached; hashed assets are immutable with correct content types", async () => {
    const server = await app(BUILT);
    expect((await server.inject({ method: "GET", url: "/console/overview" })).headers["cache-control"]).toBe(
      "no-store"
    );
    const js = await server.inject({ method: "GET", url: "/console/assets/console-ABC123.js" });
    expect(js.headers["content-type"]).toContain("text/javascript");
    expect(js.headers["cache-control"]).toContain("immutable");
    expect(
      (await server.inject({ method: "GET", url: "/console/assets/console-ABC123.css" })).headers["content-type"]
    ).toContain("text/css");
  });

  it("refuses path traversal, dotfiles and non-asset names", async () => {
    const server = await app({ ...BUILT, ".env": "SECRET=1" });
    for (const url of [
      "/console/assets/..%2F..%2Fpackage.json",
      "/console/assets/%2e%2e%2f%2e%2e%2fetc%2fpasswd",
      "/console/assets/.env",
      "/console/assets/index.html",
      "/console/assets/nope.js",
      "/console/assets/a%00b.js"
    ]) {
      const res = await server.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(404);
      expect(res.body).not.toContain("SECRET");
    }
  });

  it("reports an unbuilt console as 503, not a crash or an empty page", async () => {
    const res = await (await app(undefined)).inject({ method: "GET", url: "/console/overview" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "control console is not built", code: "console_not_built" });
  });

  it("serves no data: shell and assets carry no session or work-item state", async () => {
    const res = await (await app(BUILT)).inject({ method: "GET", url: "/console/overview" });
    expect(res.headers["set-cookie"]).toBeUndefined();
  });
});
