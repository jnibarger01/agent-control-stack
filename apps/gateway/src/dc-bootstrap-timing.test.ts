import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { onDcBootstrapTiming, registerDcBootstrapTiming, type DcBootstrapTimingFields } from "./dc-bootstrap-timing.js";
import { buildGateway, type GatewayCredential } from "./server.js";

const WORKER_TOKEN = "bridge-worker-token-timing-0123456789";
const RUNTIME_ID = "dc-timing-runtime";
const FINGERPRINT = "b".repeat(64);
const SCOPES = ["fs.read", "fs.write", "process.exec", "process.spawn"];
const CORRELATION = "0b6f2a4e-6d0c-4f7e-9a51-2f3c8d1e7a90";
const credentials: GatewayCredential[] = [
  {
    id: "dc-bridge",
    token: WORKER_TOKEN,
    actor: "agent",
    actorId: "acs-dc-bridge",
    roles: ["service", "worker"],
    scopes: ["acs:read", "acs:write", "acs:worker"]
  }
];

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function gateway() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "acs-dc-timing-")));
  const { privateKey } = generateKeyPairSync("ed25519");
  const app = buildGateway({
    dbPath: join(root, "control.db"),
    logger: false,
    auth: { token: "", actor: "user", actorId: "user", credentials },
    desktopCommanderCapability: {
      runtimeId: RUNTIME_ID,
      keyId: "timing-key",
      privateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url"),
      ttlMs: 29_000,
      identityConfigFingerprint: FINGERPRINT,
      runtimeScopes: SCOPES
    },
    desktopCommanderContainment: { allowedRoots: [root], deniedRoots: [] }
  });
  registerDcBootstrapTiming(app);
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  cleanups.push(() => app.close());
  return app;
}

describe("dc runtime bootstrap timing (#375 diagnostics)", () => {
  it("emits phase timings for issue and complete, correlated, with no secret material", async () => {
    const app = await gateway();
    const records: DcBootstrapTimingFields[] = [];
    cleanups.push(onDcBootstrapTiming((fields) => records.push(fields)));
    const headers = { authorization: `Bearer ${WORKER_TOKEN}`, "x-acs-request-id": CORRELATION };

    const issued = await app.inject({
      method: "POST",
      url: "/dc/runtime/bootstrap",
      headers,
      payload: { runtimeId: RUNTIME_ID, identityConfigFingerprint: FINGERPRINT, scopes: SCOPES }
    });
    expect(issued.statusCode).toBe(201);
    const { challenge } = issued.json();
    const completed = await app.inject({
      method: "POST",
      url: "/dc/runtime/bootstrap/complete",
      headers,
      payload: {
        runtimeId: RUNTIME_ID,
        identityConfigFingerprint: FINGERPRINT,
        scopes: SCOPES,
        challenge,
        runtimeIdentity: { schemaVersion: 1, runtimeId: RUNTIME_ID, challenge, scopes: SCOPES }
      }
    });
    expect(completed.statusCode).toBe(204);
    // A replay is rejected; it is still timed.
    const rejected = await app.inject({
      method: "POST",
      url: "/dc/runtime/bootstrap/complete",
      headers: { authorization: `Bearer ${WORKER_TOKEN}` },
      payload: {
        runtimeId: RUNTIME_ID,
        identityConfigFingerprint: FINGERPRINT,
        scopes: SCOPES,
        challenge,
        runtimeIdentity: { schemaVersion: 1, runtimeId: RUNTIME_ID, challenge, scopes: SCOPES }
      }
    });
    expect(rejected.statusCode).toBeGreaterThanOrEqual(400);

    expect(records.map((record) => [record.route, record.statusCode])).toEqual([
      ["/dc/runtime/bootstrap", 201],
      ["/dc/runtime/bootstrap/complete", 204],
      ["/dc/runtime/bootstrap/complete", rejected.statusCode]
    ]);
    for (const record of records) {
      expect(record.event).toBe("dc_runtime_bootstrap_timing");
      expect(record.requestId).toEqual(expect.any(String));
      for (const key of [
        "receiptToHandlerMs",
        "preRegistryMs",
        "lockWaitMs",
        "statementsMs",
        "commitMs",
        "totalMs",
        "eventLoopDelayMaxMs",
        "eventLoopDelayP99Ms"
      ] as const)
        expect(record[key], key).toBeGreaterThanOrEqual(0);
      const text = JSON.stringify(record);
      for (const secret of [WORKER_TOKEN, challenge, FINGERPRINT, "Bearer"]) expect(text).not.toContain(secret);
    }
    expect(records[0]!.correlationId).toBe(CORRELATION);
    expect(records[1]!.correlationId).toBe(CORRELATION);
    expect(records[2]!.correlationId).toBeUndefined();
    expect(records.map((record) => record.transactionOutcome)).toEqual(["committed", "committed", "rolled_back"]);
  });

  it("drops a malformed correlation id instead of echoing it", async () => {
    const app = await gateway();
    const records: DcBootstrapTimingFields[] = [];
    cleanups.push(onDcBootstrapTiming((fields) => records.push(fields)));
    await app.inject({
      method: "POST",
      url: "/dc/runtime/bootstrap",
      headers: { authorization: `Bearer ${WORKER_TOKEN}`, "x-acs-request-id": `Bearer ${WORKER_TOKEN} <x>` },
      payload: { runtimeId: RUNTIME_ID, identityConfigFingerprint: FINGERPRINT, scopes: SCOPES }
    });
    expect(records).toHaveLength(1);
    expect(records[0]!.correlationId).toBeUndefined();
    expect(JSON.stringify(records[0])).not.toContain(WORKER_TOKEN);
  });
});
