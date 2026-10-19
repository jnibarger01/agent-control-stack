import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseOverviewReadModel, parseQueueReadModel, parseTraceReadModel } from "@agent-control-stack/mission-control-contract";
import { SqliteWorkItemStore } from "@agent-control-stack/work-items";
import { buildGateway } from "./server.js";
import { MISSION_CONTROL_WEB_CSP } from "./mission-control-web.js";

const TOKEN = "t".repeat(48);
const auth = { Authorization: `Bearer ${TOKEN}` };

describe("mission control web hosting and overview endpoint", () => {
  let dir: string;
  let dist: string;
  let seededId: string;
  let savedToken: string | undefined;
  let savedFlag: string | undefined;

  beforeEach(() => {
    savedToken = process.env.ACS_GATEWAY_TOKEN;
    savedFlag = process.env.ACS_MC_WEB;
    delete process.env.ACS_GATEWAY_TOKEN;
    delete process.env.ACS_MC_WEB;
    dir = mkdtempSync(join(tmpdir(), "acs-mcweb-"));
    dist = join(dir, "dist");
    mkdirSync(join(dist, "assets"), { recursive: true });
    writeFileSync(join(dist, "index.html"), "<!doctype html><title>mcweb</title>");
    writeFileSync(join(dist, "assets", "app-abc123.js"), "console.log(1)");
    writeFileSync(join(dir, "secret.txt"), "outside");
    const store = new SqliteWorkItemStore(join(dir, "control.db"));
    seededId = store.create({ title: "Seed item", requester: "user", intent: "Inspect", target: { cwd: "/home/private/repo" }, requestedActions: [], risk: "low" }).id;
    store.close();
  });

  afterEach(() => {
    if (savedToken === undefined) delete process.env.ACS_GATEWAY_TOKEN;
    else process.env.ACS_GATEWAY_TOKEN = savedToken;
    if (savedFlag === undefined) delete process.env.ACS_MC_WEB;
    else process.env.ACS_MC_WEB = savedFlag;
    rmSync(dir, { recursive: true, force: true });
  });

  const gateway = (missionControlWeb?: { enabled?: boolean; distDir?: string }) =>
    buildGateway({
      dbPath: join(dir, "control.db"),
      logger: false,
      moa: false,
      auth: { token: TOKEN, actor: "user" },
      ...(missionControlWeb ? { missionControlWeb } : {})
    });

  it("overview requires authentication", async () => {
    const app = gateway();
    try {
      expect((await app.inject({ method: "GET", url: "/api/mission-control/overview" })).statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("overview returns a contract-valid, sanitized, uncached read model", async () => {
    const app = gateway();
    try {
      const res = await app.inject({ method: "GET", url: "/api/mission-control/overview", headers: auth });
      expect(res.statusCode).toBe(200);
      expect(res.headers["cache-control"]).toBe("no-store");
      const parsed = parseOverviewReadModel(res.json());
      expect(parsed.ok).toBe(true);
      expect(res.body).not.toContain("/home/private/repo");
      expect(res.body).toContain("Seed item");
    } finally {
      await app.close();
    }
  });

  it("serves nothing under /next/ unless the flag is on", async () => {
    const app = gateway({ distDir: dist });
    try {
      expect((await app.inject({ method: "GET", url: "/next/" })).statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("serves the shell with a strict CSP when enabled, and the legacy console is unaffected", async () => {
    const app = gateway({ enabled: true, distDir: dist });
    try {
      const shell = await app.inject({ method: "GET", url: "/next/" });
      expect(shell.statusCode).toBe(200);
      expect(shell.body).toContain("mcweb");
      expect(shell.headers["content-security-policy"]).toBe(MISSION_CONTROL_WEB_CSP);
      expect(shell.headers["x-content-type-options"]).toBe("nosniff");
      expect(shell.headers["cache-control"]).toBe("no-store");
      const asset = await app.inject({ method: "GET", url: "/next/assets/app-abc123.js" });
      expect(asset.statusCode).toBe(200);
      expect(asset.headers["cache-control"]).toContain("immutable");
      expect(asset.headers["content-type"]).toContain("javascript");
      expect((await app.inject({ method: "GET", url: "/next" })).headers.location).toBe("/next/");
      const legacy = await app.inject({ method: "GET", url: "/", headers: auth });
      expect(legacy.statusCode).toBe(200);
      expect(legacy.body).toContain("ACS Mission Control");
    } finally {
      await app.close();
    }
  });

  it("404s missing assets and traversal attempts instead of returning HTML or files", async () => {
    const app = gateway({ enabled: true, distDir: dist });
    try {
      expect((await app.inject({ method: "GET", url: "/next/assets/missing.js" })).statusCode).toBe(404);
      for (const url of ["/next/..%2Fsecret.txt", "/next/%2e%2e/secret.txt", "/next/assets/..%2F..%2Fsecret.txt"]) {
        const res = await app.inject({ method: "GET", url });
        expect(res.body, url).not.toContain("outside");
      }
    } finally {
      await app.close();
    }
  });

  it("malformed percent-encoding is a 400/404, never a 500", async () => {
    const app = gateway({ enabled: true, distDir: dist });
    try {
      for (const url of ["/next/%25zz", "/next/%E0%A4%A", "/next/%2500", "/next/%25252e%25252e%25252fsecret.txt"]) {
        const res = await app.inject({ method: "GET", url });
        expect([200, 400, 404], url).toContain(res.statusCode);
        expect(res.body, url).not.toContain("outside");
        expect(res.body, url).not.toContain("URI malformed");
      }
    } finally {
      await app.close();
    }
  });

  it("fails closed with 503 when enabled but not built", async () => {
    const app = gateway({ enabled: true, distDir: join(dir, "nope") });
    try {
      const res = await app.inject({ method: "GET", url: "/next/" });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ error: "mission_control_web_not_built" });
    } finally {
      await app.close();
    }
  });

  it("queue and trace require authentication", async () => {
    const app = gateway();
    try {
      expect((await app.inject({ method: "GET", url: "/api/mission-control/queue" })).statusCode).toBe(401);
      expect((await app.inject({ method: "GET", url: `/api/mission-control/work-items/${seededId}/trace` })).statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("queue returns a contract-valid sanitized model", async () => {
    const app = gateway();
    try {
      const res = await app.inject({ method: "GET", url: "/api/mission-control/queue", headers: auth });
      expect(res.statusCode).toBe(200);
      expect(res.headers["cache-control"]).toBe("no-store");
      const parsed = parseQueueReadModel(res.json());
      expect(parsed.ok && parsed.value.items.some((i) => i.id === seededId)).toBe(true);
      expect(res.body).not.toContain("/home/private/repo");
    } finally {
      await app.close();
    }
  });

  it("trace returns a contract-valid model for a real item and 404 for a missing one", async () => {
    const app = gateway();
    try {
      const res = await app.inject({ method: "GET", url: `/api/mission-control/work-items/${seededId}/trace`, headers: auth });
      expect(res.statusCode).toBe(200);
      const parsed = parseTraceReadModel(res.json());
      expect(parsed.ok).toBe(true);
      expect(parsed.ok && parsed.value.stages.map((s) => s.key)).toEqual(["request", "policy", "plan", "admission", "approval", "attempt", "lease", "result"]);
      expect(res.body).not.toContain("/home/private/repo");
      const missing = await app.inject({ method: "GET", url: "/api/mission-control/work-items/does-not-exist/trace", headers: auth });
      expect(missing.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
