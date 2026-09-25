/**
 * End-to-end authority chain without a device: real Strands SDK loop ->
 * AcsClient -> real ACS gateway routes (policy, approval, dispatch, bridge
 * issuance, result acceptance, audited result read) -> simulated managed
 * bridge. Only the Desktop Commander process itself is stubbed.
 *
 * Excluded from `tsc -p` (it imports the gateway build); run by vitest.
 */
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InterruptResponseContent } from "@strands-agents/sdk";
import { buildGateway } from "@agent-control-stack/gateway";
import { describe, expect, it } from "vitest";
import { AcsClient } from "./acs-client.js";
import { createAcsAgent } from "./agent.js";
import { ScriptedToolModel } from "./test-model.js";

const OP = "op-token";
const BRIDGE = "bridge-token";
const RUNTIME_ID = "dc-test-runtime";
const FP = "a".repeat(64);
const SCOPES = ["fs.read", "fs.write", "process.exec", "process.spawn"];

type App = ReturnType<typeof buildGateway>;

function injectFetch(app: App): typeof fetch {
  return (async (url: URL | string, init?: RequestInit) => {
    const u = new URL(String(url));
    const res = await app.inject({
      method: (init?.method ?? "GET") as "GET" | "POST",
      url: u.pathname,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      ...(init?.body ? { payload: String(init.body) } : {})
    });
    return new Response(res.statusCode === 204 ? null : res.body, { status: res.statusCode });
  }) as typeof fetch;
}

async function bridgeStep(app: App, stdout: string): Promise<boolean> {
  const next = await app.inject({
    method: "POST",
    url: "/dc/harness/next",
    headers: { authorization: `Bearer ${BRIDGE}` }
  });
  if (next.statusCode === 204) return false;
  const job = next.json();
  const issued = await app.inject({
    method: "POST",
    url: "/dc/capability/issue",
    headers: { authorization: `Bearer ${BRIDGE}`, "x-dc-actor": job.actor },
    payload: {
      client_id: "acs-strands-harness",
      tool: job.tool,
      argsSummary: JSON.stringify(job.arguments),
      workItemId: job.workItemId
    }
  });
  expect(issued.statusCode).toBe(200);
  const b = issued.json();
  const now = new Date().toISOString();
  const res = await app.inject({
    method: "POST",
    url: `/work-items/${b.workItemId}/results`,
    headers: { authorization: `Bearer ${BRIDGE}` },
    payload: {
      workItemId: b.workItemId,
      attemptId: b.attemptId,
      leaseId: b.leaseId,
      workerId: b.workerId,
      actionHash: b.claimActionHash,
      planHash: b.planHash,
      inputHash: b.inputHash,
      fencingEpoch: b.leaseEpoch,
      idempotencyKey: createHash("sha256")
        .update(`{"attemptId":"${b.attemptId}","domain":"acs.attempt-result.v1"}`)
        .digest("hex"),
      outcome: "succeeded",
      startedAt: now,
      finishedAt: now,
      summary: stdout,
      stdout,
      simulationMetadata: {
        executionMode: "desktop_commander",
        simulated: false,
        backend: "desktop-commander-mcp",
        toolName: job.tool,
        invocationFingerprint: b.capability.payload.invocationHash,
        requestId: b.attemptId
      }
    }
  });
  expect(res.statusCode).toBe(201);
  return true;
}

async function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "strands-acs-e2e-")));
  const { privateKey } = generateKeyPairSync("ed25519");
  const app = buildGateway({
    dbPath: join(root, "control.db"),
    logger: false,
    auth: {
      token: "",
      actor: "user",
      actorId: "user",
      credentials: [
        {
          id: "op",
          token: OP,
          actor: "user",
          actorId: "user",
          roles: ["operator"],
          scopes: ["acs:read", "acs:write", "acs:approve"]
        },
        {
          id: "dc-bridge",
          token: BRIDGE,
          actor: "agent",
          actorId: "acs-dc-bridge",
          roles: ["service", "worker"],
          scopes: ["acs:read", "acs:write", "acs:worker"]
        }
      ]
    },
    desktopCommanderCapability: {
      runtimeId: RUNTIME_ID,
      keyId: "k",
      privateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url"),
      ttlMs: 29_000,
      identityConfigFingerprint: FP,
      runtimeScopes: SCOPES
    },
    desktopCommanderContainment: { allowedRoots: [root], deniedRoots: [] }
  });
  const boot = await app.inject({
    method: "POST",
    url: "/dc/runtime/bootstrap",
    headers: { authorization: `Bearer ${BRIDGE}` },
    payload: { runtimeId: RUNTIME_ID, identityConfigFingerprint: FP, scopes: SCOPES }
  });
  const { challenge } = boot.json();
  await app.inject({
    method: "POST",
    url: "/dc/runtime/bootstrap/complete",
    headers: { authorization: `Bearer ${BRIDGE}` },
    payload: {
      runtimeId: RUNTIME_ID,
      identityConfigFingerprint: FP,
      scopes: SCOPES,
      challenge,
      runtimeIdentity: { schemaVersion: 1, runtimeId: RUNTIME_ID, challenge, scopes: SCOPES }
    }
  });
  return { root, app };
}

describe("Strands -> ACS -> managed bridge (in-process)", () => {
  it("runs a read and a human-approved write through ACS, each executed exactly once with audit correlation", async () => {
    const { root, app } = await setup();
    try {
      let bridgeRuns = 0;
      const timing = {
        pollMs: 1,
        waitMs: 50,
        redispatchMs: 10_000,
        sleep: async () => {
          if (await bridgeStep(app, "agent-control-stack\nsandbox")) bridgeRuns += 1;
        }
      };
      const api = new AcsClient("http://127.0.0.1:3000", OP, injectFetch(app));

      const read = createAcsAgent({
        api,
        model: new ScriptedToolModel("list_directory", { path: root }),
        sessionId: "s-read",
        timing
      });
      const r = await read.invoke("list");
      expect(r.stopReason).toBe("endTurn");
      expect(bridgeRuns).toBe(1);

      const model = new ScriptedToolModel("write_file", { path: join(root, "smoke.txt"), content: "hello" });
      const write = createAcsAgent({ api, model, sessionId: "s-write", timing });
      let w = await write.invoke("write");
      expect(w.stopReason).toBe("interrupt");
      const reason = w.interrupts![0].reason as { code: string; workItemId: string; correlationId: string };
      expect(reason.code).toBe("require_approval");
      expect(bridgeRuns).toBe(1);

      // Operator approves through ACS; the resume message itself grants nothing.
      const pending = (
        await app.inject({
          method: "GET",
          url: `/work-items/${reason.workItemId}`,
          headers: { authorization: `Bearer ${OP}` }
        })
      ).json();
      const actionHash = pending.events.find((e: { name: string }) => e.name === "policy.decided").body.actionHash;
      const approved = await app.inject({
        method: "POST",
        url: `/work-items/${reason.workItemId}/approve`,
        headers: { authorization: `Bearer ${OP}` },
        payload: { actionHash, reason: "operator approved smoke write" }
      });
      expect(approved.statusCode).toBe(200);
      w = await write.invoke(
        w.interrupts!.map((i) => new InterruptResponseContent({ interruptId: i.id, response: "resume" }))
      );
      expect(w.stopReason).toBe("endTurn");
      expect(bridgeRuns).toBe(2);
      expect(JSON.stringify(model.seen.at(-1))).toContain("agent-control-stack");

      const detail = (
        await app.inject({
          method: "GET",
          url: `/work-items/${reason.workItemId}`,
          headers: { authorization: `Bearer ${OP}` }
        })
      ).json();
      expect(detail.workItem.status).toBe("succeeded");
      expect(detail.workItem.metadata.correlationId).toBe(reason.correlationId);
      expect(
        detail.events.filter((e: { name: string }) => e.name === "desktop_commander.capability_issued")
      ).toHaveLength(1);
    } finally {
      await app.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
