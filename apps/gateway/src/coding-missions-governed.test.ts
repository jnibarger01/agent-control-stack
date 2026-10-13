import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NIMBLE_ROUTING_ALGORITHM_VERSION } from "@agent-control-stack/actor-router";
import type { CodingMissionPorts, ExternalOutcome } from "@agent-control-stack/coding-mission";
import {
  SqliteWorkItemStore,
  WORKER_ACTOR_REF_PREFIX,
  executionPlanSubjectInputHash
} from "@agent-control-stack/work-items";
import { afterEach, describe, expect, it } from "vitest";
import { buildGateway } from "./server.js";

/**
 * The production entry point to governed execution: the gateway builds CodingMissionController with `governance` set, and an
 * operator binds a human-issued grant over HTTP. The control plane under it (actors, grants, audit chain) is real.
 */
const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const WORKER = "semantic-winner";
const EXEC_ACTOR = "actor:exec";
const auth = { token: "t", actor: "user", actorId: "user" } as const;
const headers = { authorization: `Bearer ${auth.token}` };

const dirs: string[] = [];
const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function ok<T>(value: T): ExternalOutcome<T> {
  return { status: "succeeded", value };
}

async function world(options: { operator?: boolean; governed?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "acs-gateway-governed-"));
  dirs.push(root);
  const dbPath = join(root, "control.db");
  const control = new SqliteWorkItemStore(dbPath);
  closers.push(() => control.close());
  // The authenticated caller is the actor "user": a HUMAN operator unless the test says otherwise.
  control.registerActor({
    id: "user",
    actorType: options.operator === false ? "AGENT" : "HUMAN",
    displayName: "user",
    externalRef: "local_bearer:local-dev"
  });
  control.registerActor({ id: "human-issuer", actorType: "HUMAN", displayName: "issuer" });
  control.registerActor({
    id: EXEC_ACTOR,
    actorType: "AGENT",
    displayName: "executing agent",
    externalRef: `${WORKER_ACTOR_REF_PREFIX}${WORKER}`,
    registeredByActorId: "human-issuer"
  });
  const item = control.create({
    title: "governed over http",
    intent: "edit the repository",
    requester: "agent",
    requesterSubject: "planner",
    target: { cwd: root },
    risk: "low",
    requestedActions: [{ kind: "fs.read", description: "inspect", params: { paths: [root] } }]
  });
  const grant = control.issueAutonomousAuthority(
    {
      missionId: item.id,
      issuedByActorId: "human-issuer",
      requestId: "grant-1",
      expectedSubjectInputHash: executionPlanSubjectInputHash(item),
      definition: {
        executingActorId: EXEC_ACTOR,
        scope: [{ kind: "path", id: root, coverage: "descendants" }],
        toolClasses: [{ runtime: "sandbox", toolName: "code_edit" }],
        maximumPrivileges: ["fs.read", "fs.write"],
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        limits: { maxOperations: 50, maxRuntimeMs: 600_000, maxParallelOperations: 4, maxAttemptsPerOperation: 3 }
      },
      reason: "bounded coding mission"
    },
    { via: "policy_gate", actorId: "human-issuer" }
  );

  const executed: string[] = [];
  const ports: CodingMissionPorts = {
    now: () => new Date().toISOString(),
    deploymentPolicy: { requirement: () => ({ required: false, action: "none", impact: "none" }) },
    planner: { decompose: () => [{ operationId: "edit-api", dependsOn: [], title: "edit api" }] },
    router: {
      route: async () => ({
        workerId: WORKER,
        algorithm: NIMBLE_ROUTING_ALGORITHM_VERSION,
        decision: { selected: WORKER }
      })
    },
    coder: {
      execute: async ({ operationId }) => {
        executed.push(operationId);
        return ok({ resultHash: "result-1", files: ["api.ts"] });
      },
      observe: async () => ({ status: "absent" }),
      idempotent: true
    },
    reconciler: { reconcile: async () => ok({ headSha: HEAD, conflicts: [] }) },
    validator: {
      validate: async () =>
        ok({
          checks: {
            tests: "PASS",
            typecheck: "PASS",
            lint: "PASS",
            format: "PASS",
            repository: "PASS",
            review: "PASS"
          },
          risks: []
        })
    },
    publisher: {
      publish: async () => ok({ prNumber: 7, prUrl: "https://example.test/pull/7", headSha: HEAD }),
      observe: async () => ({ status: "absent" })
    },
    baseObserver: { currentBaseSha: async () => BASE },
    admission: { acquire: async () => ({ permitId: "permit-1" }) },
    merger: { merge: async () => ok({ mergeSha: "c".repeat(40) }), observe: async () => ({ status: "absent" }) },
    deployer: { deploy: async () => ok({ deploymentId: "d" }), observe: async () => ({ status: "absent" }) },
    verifier: { verify: async () => ({ passed: true, checks: { health: "PASS" } }) },
    ...(options.governed === false ? {} : { governance: { mode: "enforce" as const } })
  };
  const app = buildGateway({ dbPath, logger: false, auth, codingMissionPorts: ports });
  closers.push(() => app.close());
  const create = () =>
    app.inject({
      method: "POST",
      url: "/coding-missions",
      headers,
      payload: { missionId: item.id, repository: "example/repo", baseRef: "main", baseSha: BASE, summary: "governed" }
    });
  const bind = (grantId: string, extra: { headers?: Record<string, string>; id?: string } = {}) =>
    app.inject({
      method: "POST",
      url: `/coding-missions/${extra.id ?? item.id}/authority`,
      headers: extra.headers ?? headers,
      payload: { grantId }
    });
  const graph = () => app.inject({ method: "GET", url: `/coding-missions/${item.id}/authority-graph`, headers });
  return { app, control, item, grant, executed, create, bind, graph };
}

describe("governed execution over HTTP", () => {
  it("waits for authority, runs after a human operator binds a grant, and exposes the authority graph", async () => {
    const w = await world();
    const created = await w.create();
    expect(created.statusCode).toBe(201);
    // Nothing runs while the mission has no authority.
    expect(created.json()).toMatchObject({ state: "RUNNING" });
    expect(w.executed).toEqual([]);
    expect((await w.graph()).json()).toMatchObject({
      integrity: "verified",
      root: { state: "no_authority" },
      nodes: [
        expect.objectContaining({ unitId: "edit-api", effective: expect.objectContaining({ state: "no_authority" }) })
      ]
    });

    const bound = await w.bind(w.grant.grantId);
    expect(bound.statusCode).toBe(200);
    expect(bound.json()).toMatchObject({
      authority: {
        missionId: w.item.id,
        grantId: w.grant.grantId,
        executingActorId: EXEC_ACTOR,
        approverId: "human-issuer"
      },
      mission: { state: "WAITING_FOR_APPROVAL" }
    });
    expect(JSON.stringify(bound.json())).not.toMatch(/token|secret|authorization/iu);
    // The executor ran exactly once, after the gate, and the mission moved on to the human approval boundary.
    expect(w.executed).toEqual(["edit-api"]);

    const graph = (await w.graph()).json() as {
      integrity: string;
      root: { state: string; grantId: string };
      nodes: Array<{ permittedLanes: string[]; effective: { state: string } }>;
    };
    expect(graph).toMatchObject({ integrity: "verified", root: { state: "active", grantId: w.grant.grantId } });
    expect(graph.nodes[0]).toMatchObject({ permittedLanes: ["coder"], effective: { state: "active" } });
  });

  it("requires a human operator to bind authority", async () => {
    const w = await world({ operator: false });
    await w.create();
    const refused = await w.bind(w.grant.grantId);
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ code: "operator_required" });
    expect(w.executed).toEqual([]);
  });

  it("requires authentication", async () => {
    const w = await world();
    await w.create();
    expect((await w.bind(w.grant.grantId, { headers: {} })).statusCode).toBe(401);
    expect(
      (await w.app.inject({ method: "GET", url: `/coding-missions/${w.item.id}/authority-graph` })).statusCode
    ).toBe(401);
    expect(w.executed).toEqual([]);
  });

  it("refuses a grant that does not exist, is revoked, or has a malformed id, and runs nothing", async () => {
    const w = await world();
    await w.create();
    expect((await w.bind("grant-that-does-not-exist")).statusCode).toBe(409);
    expect((await w.bind("bad id with spaces")).statusCode).toBe(400);
    w.control.revokeAutonomousAuthority(w.grant.grantId, "human-issuer", "stop", {
      via: "policy_gate",
      actorId: "human-issuer"
    });
    expect((await w.bind(w.grant.grantId)).statusCode).toBe(409);
    expect(w.executed).toEqual([]);
    expect((await w.graph()).json()).toMatchObject({ root: { state: "no_authority" } });
  });

  it("reports an unknown mission, and a controller without governance, honestly", async () => {
    const w = await world();
    expect(
      (await w.app.inject({ method: "GET", url: "/coding-missions/nope/authority-graph", headers })).statusCode
    ).toBe(404);
    const off = await world({ governed: false });
    await off.create();
    const response = await off.bind(off.grant.grantId);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "governed_execution_disabled" });
    expect((await off.graph()).statusCode).toBe(409);
    // Without governance the mission runs as it always has.
    expect(off.executed).toEqual(["edit-api"]);
  });
});
