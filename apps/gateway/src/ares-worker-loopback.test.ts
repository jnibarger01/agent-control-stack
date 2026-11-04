import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createPolicyEngine } from "@agent-control-stack/policy-gate";
import { stableHash } from "@agent-control-stack/shared";
import { SqliteWorkItemStore, workItemSchema } from "@agent-control-stack/work-items";
import { buildGateway } from "./server.js";

const ALICE = "synthetic-alice-human-0123456789abcdef";
const BOB = "synthetic-bob-human-0123456789abcdef012";
const WORKER = "synthetic-ares-worker-0123456789abcdef";
const object = z.record(z.string(), z.unknown());

/** Direct HTTP socket: no proxy, ambient credentials, external adapters or real executors. */
async function call(origin: string, path: string, method = "GET", token?: string, payload?: unknown) {
  const data = payload === undefined ? undefined : JSON.stringify(payload);
  return await new Promise<{ status: number; text: string; body: Record<string, unknown> }>((resolve, reject) => {
    const req = request(
      origin + path,
      {
        method,
        agent: false,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {})
        }
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (part: string) => {
          text += part;
        });
        res.on("end", () => {
          try {
            resolve({
              status: res.statusCode ?? 0,
              text,
              body: String(res.headers["content-type"]).includes("application/json")
                ? object.parse(JSON.parse(text))
                : {}
            });
          } catch (error) {
            reject(error);
          }
        });
      }
    );
    req.setTimeout(5_000, () => req.destroy(new Error("synthetic loopback request timed out")));
    req.on("error", reject);
    req.end(data);
  });
}

afterEach(() => vi.unstubAllEnvs());

describe("ARES worker over disposable loopback HTTP", () => {
  it("binds a real device-flow requester to independent approval and a budgeted single-result lease", async () => {
    vi.stubEnv("ACS_DEVICE_CLIENT_IDS", "acs-cli,ares-studio");
    const directory = mkdtempSync(join(tmpdir(), "acs-ares-loopback-"));
    const dbPath = join(directory, "control.db");
    const seed = new SqliteWorkItemStore(dbPath);
    try {
      seed.registerActor({ id: "alice", actorType: "HUMAN", displayName: "Synthetic Alice" });
      seed.registerActor({ id: "bob", actorType: "HUMAN", displayName: "Synthetic Bob" });
    } finally {
      seed.close();
    }
    const app = buildGateway({
      dbPath,
      logger: false,
      auth: {
        token: "",
        actor: "user",
        credentials: [
          {
            id: "alice",
            token: ALICE,
            actor: "user",
            actorId: "alice",
            roles: ["operator"],
            scopes: ["acs:read", "acs:write", "acs:approve", "acs:work:read", "acs:work:create"]
          },
          {
            id: "bob",
            token: BOB,
            actor: "user",
            actorId: "bob",
            roles: ["operator"],
            scopes: ["acs:read", "acs:write", "acs:approve", "acs:work:read", "acs:work:create"]
          },
          {
            id: "ares",
            token: WORKER,
            actor: "agent",
            actorId: "ares",
            roles: ["worker"],
            scopes: ["acs:read", "acs:worker"]
          }
        ]
      }
    });
    try {
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address();
      if (!address || typeof address === "string") throw new Error("expected a disposable TCP listener");
      const origin = `http://127.0.0.1:${address.port}`;
      expect((await call(origin, "/work-items")).status).toBe(401);
      const pair = generateKeyPairSync("ed25519");
      const issue = async () => {
        const res = await call(origin, "/oauth/device/code", "POST", undefined, {
          client_id: "ares-studio",
          device_name: "synthetic ARES device",
          scope: "acs:work:create acs:work:read",
          device_public_key: pair.publicKey.export({ type: "spki", format: "pem" }).toString()
        });
        expect(res.status).toBe(200);
        return z.object({ user_code: z.string(), device_code: z.string() }).parse(res.body);
      };
      const issued = await issue();
      const page = await call(origin, `/device/verify?user_code=${encodeURIComponent(issued.user_code)}`, "GET", ALICE);
      expect(page.text).toContain("<dt>Client ID</dt><dd>ares-studio</dd>");
      expect(
        (await call(origin, "/device/verify", "POST", ALICE, { user_code: issued.user_code, action: "approve" })).status
      ).toBe(200);
      const exchange = await call(origin, "/oauth/token", "POST", undefined, {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: "ares-studio",
        device_code: issued.device_code,
        device_signature: sign(
          null,
          Buffer.from(`acs-device-code-proof-v1\n${issued.device_code}`),
          pair.privateKey
        ).toString("base64url")
      });
      expect(exchange.status).toBe(200);
      const device = z
        .object({ access_token: z.string(), device_id: z.string(), principal: z.string() })
        .parse(exchange.body);
      expect(device.principal).toBe("alice");
      const argsHash = "a".repeat(64);
      const created = await call(origin, "/work-items", "POST", device.access_token, {
        title: "synthetic ARES socket test",
        requesterSubject: "bob",
        requester: "system",
        intent: "no real execution",
        target: { services: ["ares"] },
        risk: "low",
        requestedActions: [
          {
            kind: "ares.analyze.local",
            description: "synthetic",
            params: { aresArgsHash: argsHash, aresPrincipal: "local-alice", artifactId: "synthetic" }
          }
        ]
      });
      expect(created.status).toBe(201);
      const item = workItemSchema.parse(created.body);
      expect(item.requesterSubject).toBe("alice");
      const approve = (token: string, actor: string) =>
        call(origin, `/work-items/${item.id}/approve`, "POST", token, {
          reason: "synthetic independent approval",
          actionHash: createPolicyEngine().evaluateWorkItem(item, actor, "approve")[0]!.actionHash
        });
      expect((await approve(ALICE, "alice")).status).toBe(403);
      expect((await approve(device.access_token, "alice")).status).toBe(403);
      expect((await call(origin, "/worker/claim", "POST", WORKER, { workItemId: item.id })).body.claimed).toBe(false);
      expect((await approve(BOB, "bob")).status).toBe(200);
      const claims = await Promise.all(
        [1, 2].map(() => call(origin, "/worker/claim", "POST", WORKER, { workItemId: item.id, leaseMs: 600_000 }))
      );
      expect(claims.filter((res) => res.body.claimed === true)).toHaveLength(1);
      const claim = z
        .object({
          workItem: z.object({
            id: z.string(),
            attemptId: z.string(),
            leaseId: z.string(),
            workerId: z.string(),
            actionHash: z.string(),
            planHash: z.string(),
            inputHash: z.string(),
            fencingEpoch: z.number(),
            startedAt: z.string(),
            leaseExpiresAt: z.string()
          })
        })
        .parse(claims.find((res) => res.body.claimed === true)?.body).workItem;
      expect(Date.parse(claim.leaseExpiresAt) - Date.parse(claim.startedAt)).toBeLessThanOrEqual(300_000);
      const now = new Date().toISOString();
      const result = {
        workItemId: item.id,
        attemptId: claim.attemptId,
        leaseId: claim.leaseId,
        workerId: claim.workerId,
        actionHash: claim.actionHash,
        planHash: claim.planHash,
        inputHash: claim.inputHash,
        fencingEpoch: claim.fencingEpoch,
        idempotencyKey: stableHash({ domain: "acs.attempt-result.v1", attemptId: claim.attemptId }),
        outcome: "succeeded",
        startedAt: now,
        finishedAt: now,
        summary: "synthetic worker report; no adapter executed",
        artifacts: [],
        structuredOutput: { aresArgsHash: argsHash, resultDigest: null },
        simulationMetadata: {
          executionMode: "ares",
          simulated: false,
          backend: "ares-studio",
          toolName: "ares.analyze.local",
          requestId: claim.attemptId,
          invocationFingerprint: stableHash({
            domain: "ares.invocation.v1",
            attemptId: claim.attemptId,
            argsHash,
            resultDigest: null
          })
        }
      };
      expect(
        (await call(origin, `/work-items/${item.id}/results`, "POST", WORKER, { ...result, inputHash: "b".repeat(64) }))
          .status
      ).toBeGreaterThanOrEqual(400);
      const accepted = await call(origin, `/work-items/${item.id}/results`, "POST", WORKER, result);
      expect(accepted.status).toBe(201);
      const replay = await call(origin, `/work-items/${item.id}/results`, "POST", WORKER, result);
      expect(replay.status).toBe(200);
      expect(replay.body.result).toEqual(accepted.body.result);
      expect(
        (
          await call(origin, `/work-items/${item.id}/results`, "POST", WORKER, {
            ...result,
            summary: "conflicting replay"
          })
        ).status
      ).toBe(409);
      const recorded = await call(origin, `/work-items/${item.id}`, "GET", device.access_token);
      const events = z.object({ events: z.array(z.object({ name: z.string() })) }).parse(recorded.body).events;
      expect(events.filter((event) => event.name === "execution_result.accepted")).toHaveLength(1);
      const secondDevice = await issue();
      const delegatedManagement = {
        view: (
          await call(
            origin,
            `/device/verify?user_code=${encodeURIComponent(secondDevice.user_code)}`,
            "GET",
            device.access_token
          )
        ).status,
        approve: (
          await call(origin, "/device/verify", "POST", device.access_token, {
            user_code: secondDevice.user_code,
            action: "approve"
          })
        ).status,
        revoke: (await call(origin, `/devices/${device.device_id}/revoke`, "POST", device.access_token, {})).status
      };
      expect(delegatedManagement).toEqual({ view: 403, approve: 403, revoke: 403 });
      expect((await call(origin, `/devices/${device.device_id}/revoke`, "POST", ALICE, {})).status).toBe(200);
      expect((await call(origin, "/work-items", "GET", device.access_token)).status).toBe(401);
    } finally {
      await app.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
