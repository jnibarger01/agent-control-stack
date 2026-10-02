import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NimbleRoutingConfigError } from "@agent-control-stack/policy-gate";
import { afterEach, describe, expect, it } from "vitest";
import { buildGateway } from "./server.js";

const testAuth = { token: "t".repeat(32), actor: "user", actorId: "user" } as const;

function nimbleChoice(): Response {
  return new Response(
    JSON.stringify({
      model: "nimble:latest",
      answers: {
        executor: {
          type: "choice",
          choice: "probe-a",
          confidence: 0.99,
          probabilities: { "probe-a": 0.99, "probe-b": 0.01 }
        }
      }
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

describe("Nimble routing readiness", () => {
  const prior = new Map<string, string | undefined>();
  const keys = [
    "ACS_NIMBLE_ROUTING_ENABLED",
    "ACS_NIMBLE_URL",
    "ACS_NIMBLE_MODEL",
    "ACS_NIMBLE_TIMEOUT_MS",
    "ACS_NIMBLE_CONFIDENCE_THRESHOLD",
    "ACS_NIMBLE_LOW_CONFIDENCE_POLICY",
    "ACS_NIMBLE_FALLBACK_MODE"
  ];

  afterEach(() => {
    for (const key of keys) {
      const value = prior.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    prior.clear();
  });

  function rememberEnv() {
    for (const key of keys) prior.set(key, process.env[key]);
  }

  it("stays ready without a nimble check when routing is disabled", async () => {
    rememberEnv();
    delete process.env.ACS_NIMBLE_ROUTING_ENABLED;
    const dir = mkdtempSync(join(tmpdir(), "acs-nimble-readyz-off-"));
    const app = buildGateway({ dbPath: join(dir, "control.db"), logger: false, auth: testAuth });
    try {
      const ready = await app.inject({ method: "GET", url: "/readyz" });
      expect(ready.statusCode).toBe(200);
      expect(ready.json().checks.nimble).toBeUndefined();
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports the configured model when Nimble answers the readiness choice", async () => {
    rememberEnv();
    process.env.ACS_NIMBLE_ROUTING_ENABLED = "1";
    process.env.ACS_NIMBLE_MODEL = "nimble:latest";
    const original = globalThis.fetch;
    globalThis.fetch = async () => nimbleChoice();
    const dir = mkdtempSync(join(tmpdir(), "acs-nimble-readyz-on-"));
    const app = buildGateway({ dbPath: join(dir, "control.db"), logger: false, auth: testAuth });
    try {
      const ready = await app.inject({ method: "GET", url: "/readyz" });
      expect(ready.statusCode).toBe(200);
      expect(ready.json().checks.nimble).toMatchObject({ ok: true, model: "nimble:latest" });
    } finally {
      globalThis.fetch = original;
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails readiness when the configured Nimble endpoint is unavailable", async () => {
    rememberEnv();
    process.env.ACS_NIMBLE_ROUTING_ENABLED = "1";
    const original = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error("connection refused");
    };
    const dir = mkdtempSync(join(tmpdir(), "acs-nimble-readyz-down-"));
    const app = buildGateway({ dbPath: join(dir, "control.db"), logger: false, auth: testAuth });
    try {
      const ready = await app.inject({ method: "GET", url: "/readyz" });
      expect(ready.statusCode).toBe(503);
      expect(ready.json().checks.nimble).toMatchObject({ ok: false, code: "unavailable" });
    } finally {
      globalThis.fetch = original;
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects invalid routing configuration before the gateway serves", () => {
    rememberEnv();
    process.env.ACS_NIMBLE_ROUTING_ENABLED = "1";
    process.env.ACS_NIMBLE_URL = "http://nimble.example/v1/systemone?token=secret";
    const dir = mkdtempSync(join(tmpdir(), "acs-nimble-readyz-config-"));
    try {
      expect(() => buildGateway({ dbPath: join(dir, "control.db"), logger: false, auth: testAuth })).toThrow(
        NimbleRoutingConfigError
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
