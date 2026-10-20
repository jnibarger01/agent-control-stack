import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteWorkItemStore } from "@agent-control-stack/work-items";
import { buildGateway } from "./server.js";
import { MISSION_CONTROL_WEB_CSP } from "./mission-control-web.js";

const TOKEN = "t".repeat(48);
const auth = { Authorization: `Bearer ${TOKEN}` };

describe("React app as the default at / (rollback is one flag)", () => {
  let dir: string;
  let dist: string;
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ["ACS_GATEWAY_TOKEN", "ACS_MC_WEB", "ACS_MC_WEB_DEFAULT"]) { saved[k] = process.env[k]; delete process.env[k]; }
    dir = mkdtempSync(join(tmpdir(), "acs-defroot-"));
    dist = join(dir, "dist");
    mkdirSync(join(dist, "assets"), { recursive: true });
    writeFileSync(join(dist, "index.html"), "<!doctype html><title>react app</title>");
    new SqliteWorkItemStore(join(dir, "control.db")).close();
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rmSync(dir, { recursive: true, force: true });
  });
  const gateway = (missionControlWeb?: { enabled?: boolean; distDir?: string; defaultRoot?: boolean }) =>
    buildGateway({ dbPath: join(dir, "control.db"), logger: false, moa: false, auth: { token: TOKEN, actor: "user" }, ...(missionControlWeb ? { missionControlWeb } : {}) });

  it("default off: / is the classic console and /legacy is the same console", async () => {
    const app = gateway({ enabled: true, distDir: dist });
    try {
      const root = await app.inject({ method: "GET", url: "/", headers: auth });
      expect(root.statusCode).toBe(200);
      expect(root.body).toContain("ACS Mission Control");
      const legacy = await app.inject({ method: "GET", url: "/legacy", headers: auth });
      expect(legacy.statusCode).toBe(200);
      expect(legacy.body).toContain("ACS Mission Control");
    } finally {
      await app.close();
    }
  });

  it("default on: an authenticated / hands off to /next/ and /legacy still serves the classic console", async () => {
    const app = gateway({ enabled: true, distDir: dist, defaultRoot: true });
    try {
      const root = await app.inject({ method: "GET", url: "/", headers: auth });
      expect(root.statusCode).toBe(302);
      expect(root.headers.location).toBe("/next/");
      for (const url of ["/legacy", "/legacy/"]) {
        const legacy = await app.inject({ method: "GET", url, headers: auth });
        expect(legacy.statusCode, url).toBe(200);
        expect(legacy.body, url).toContain("ACS Mission Control");
      }
      expect((await app.inject({ method: "GET", url: "/next/" })).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("default on: an unauthenticated / and /legacy show the login page, never a redirect loop or data", async () => {
    const app = gateway({ enabled: true, distDir: dist, defaultRoot: true });
    try {
      for (const url of ["/", "/legacy"]) {
        const res = await app.inject({ method: "GET", url });
        expect(res.statusCode, url).toBe(401);
        expect(res.body, url).toContain("login-form");
        expect(res.headers.location, url).toBeUndefined();
      }
      const next = await app.inject({ method: "GET", url: "/?next=%2Fnext%2F" });
      expect(next.body).toContain('const redirectTo = "/next/"');
      const evil = await app.inject({ method: "GET", url: "/?next=%2F%2Fevil.example%2F" });
      expect(evil.body).toContain('const redirectTo = "/"');
      expect(evil.body).not.toContain("evil.example");
      // Browsers read "\\" as "/" and drop tabs/newlines, so these leave the origin despite a single leading "/".
      for (const target of ["%2F%5Cevil.example", "%2F%5C%5Cevil.example", "%2F%09%2Fevil.example", "%2F%0A%2Fevil.example"]) {
        const res = await app.inject({ method: "GET", url: `/?next=${target}` });
        expect(res.body, target).toContain('const redirectTo = "/"');
        expect(res.body, target).not.toContain("evil.example");
      }
      // URL normalisation collapses dot-segments, so these used to render redirectTo "//evil.com" or "///evil.com".
      for (const target of ["/.//evil.com", "/..//evil.com", "/a/..//evil.com", "/%2e%2e//evil.com", "/..///evil.com", `/${"a".repeat(100_000)}`]) {
        const res = await app.inject({ method: "GET", url: `/?next=${encodeURIComponent(target)}` });
        const rendered = /const redirectTo = (".*?");/.exec(res.body)?.[1];
        expect(rendered, target.slice(0, 40)).toBe('"/"');
        expect(new URL(JSON.parse(rendered!) as string, "https://console.invalid").origin).toBe("https://console.invalid");
      }
      // A same-origin path must not be able to close the inline script.
      const breakout = await app.inject({ method: "GET", url: "/?next=%2F%3C%2Fscript%3E%3Cscript%3Ealert(1)%3C%2Fscript%3E" });
      expect(breakout.body).not.toContain("<script>alert(1)");
      expect(breakout.body.match(/<\/script>/g)?.length).toBe(1);
    } finally {
      await app.close();
    }
  });

  it("login 401 pages for /, /legacy and /legacy/ carry the /next CSP, allowing only their own inline blocks", async () => {
    const app = gateway({ enabled: true, distDir: dist, defaultRoot: true });
    try {
      for (const url of ["/", "/legacy", "/legacy/", "/?next=%2Fnext%2F"]) {
        const res = await app.inject({ method: "GET", url });
        expect(res.statusCode, url).toBe(401);
        const csp = String(res.headers["content-security-policy"] ?? "");
        const directives = new Map(csp.split(";").map((d) => d.trim().split(/\s+/)).map(([name, ...values]) => [name, values]));
        const expected = new Map(MISSION_CONTROL_WEB_CSP.split(";").map((d) => d.trim().split(/\s+/)).map(([name, ...values]) => [name, values]));
        expect([...directives.keys()].sort(), url).toEqual([...expected.keys()].sort());
        for (const [name, values] of expected) {
          if (name === "script-src" || name === "style-src") continue;
          expect(directives.get(name), `${url} ${name}`).toEqual(values);
        }
        for (const tag of ["script", "style"] as const) {
          const body = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(res.body)?.[1] ?? "";
          const hash = `'sha256-${createHash("sha256").update(body).digest("base64")}'`;
          expect(directives.get(`${tag}-src`), `${url} ${tag}`).toEqual(["'self'", hash]);
        }
      }
    } finally {
      await app.close();
    }
  });

  it("fails closed to the classic console when the React app is not built", async () => {
    const app = gateway({ enabled: true, distDir: join(dir, "not-built"), defaultRoot: true });
    try {
      const res = await app.inject({ method: "GET", url: "/", headers: auth });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain("ACS Mission Control");
    } finally {
      await app.close();
    }
  });

  it("a default request without the app enabled is ignored", async () => {
    const app = gateway({ enabled: false, distDir: dist, defaultRoot: true });
    try {
      expect((await app.inject({ method: "GET", url: "/", headers: auth })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/next/" })).statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("is driven by ACS_MC_WEB_DEFAULT, and unsetting it rolls back without a code change", async () => {
    process.env.ACS_MC_WEB = "1";
    process.env.ACS_MC_WEB_DEFAULT = "1";
    const on = gateway({ distDir: dist });
    try {
      expect((await on.inject({ method: "GET", url: "/", headers: auth })).statusCode).toBe(302);
    } finally {
      await on.close();
    }
    delete process.env.ACS_MC_WEB_DEFAULT;
    const off = gateway({ distDir: dist });
    try {
      expect((await off.inject({ method: "GET", url: "/", headers: auth })).statusCode).toBe(200);
    } finally {
      await off.close();
    }
  });

  it("counts every classic-console response so retirement is decided on evidence, not on a hunch", async () => {
    const app = gateway({ enabled: true, distDir: dist, defaultRoot: true });
    try {
      await app.inject({ method: "GET", url: "/legacy", headers: auth });
      await app.inject({ method: "GET", url: "/legacy", headers: auth });
      await app.inject({ method: "GET", url: "/", headers: auth }); // redirect to the React app: not a legacy view
      const body = (await app.inject({ method: "GET", url: "/metrics", headers: auth })).body;
      expect(body).toContain('acs_mc_legacy_console_requests_total{route="/legacy"} 2');
      expect(body).not.toContain('acs_mc_legacy_console_requests_total{route="/"}');
    } finally {
      await app.close();
    }
  });
});
