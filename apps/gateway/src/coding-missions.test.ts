import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NIMBLE_ROUTING_ALGORITHM_VERSION } from "@agent-control-stack/actor-router";
import type { CodingMissionPorts, ExternalOutcome } from "@agent-control-stack/coding-mission";
import { SqliteWorkItemStore } from "@agent-control-stack/work-items";
import { afterEach, describe, expect, it } from "vitest";
import { buildGateway } from "./server.js";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const MERGE = "c".repeat(40);
const auth = { token: "t", actor: "user", actorId: "user" } as const;

function ok<T>(value: T): ExternalOutcome<T> {
  return { status: "succeeded", value };
}

function ports(): CodingMissionPorts {
  return {
    now: () => "2026-10-02T15:00:00.000Z",
    deploymentPolicy: { requirement: () => ({ required: true, action: "restart", impact: "gateway restart" }) },
    planner: { decompose: () => [{ operationId: "edit-api", dependsOn: [], title: "edit api" }] },
    router: {
      route: async () => ({
        workerId: "semantic-winner",
        algorithm: NIMBLE_ROUTING_ALGORITHM_VERSION,
        decision: { selected: "semantic-winner" }
      })
    },
    coder: {
      execute: async () => ok({ resultHash: "result-1", files: ["api.ts"] }),
      observe: async () => ({ status: "absent" })
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
      publish: async () => ok({ prNumber: 123, prUrl: "https://example.test/pull/123", headSha: HEAD }),
      observe: async () => ({ status: "absent" })
    },
    baseObserver: { currentBaseSha: async () => BASE },
    admission: { acquire: async () => ({ permitId: "permit-1" }) },
    merger: { merge: async () => ok({ mergeSha: MERGE }), observe: async () => ({ status: "absent" }) },
    deployer: { deploy: async () => ok({ deploymentId: "restart-1" }), observe: async () => ({ status: "absent" }) },
    verifier: { verify: async () => ({ passed: true, checks: { health: "PASS" } }) }
  };
}

describe("coding mission HTTP", () => {
  let directory: string | undefined;
  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it("shows one approval and then completes without another request", async () => {
    directory = mkdtempSync(join(tmpdir(), "acs-coding-http-"));
    const dbPath = join(directory, "control.db");
    const store = new SqliteWorkItemStore(dbPath);
    store.registerActor({ id: "user", actorType: "HUMAN", displayName: "user", externalRef: "local_bearer:local-dev" });
    store.close();
    const app = buildGateway({ dbPath, logger: false, auth, codingMissionPorts: ports() });
    app.addHook("onRequest", async (request) => {
      request.headers.authorization ??= `Bearer ${auth.token}`;
    });
    const created = await app.inject({
      method: "POST",
      url: "/coding-missions",
      payload: {
        missionId: "mission-http",
        repository: "example/repo",
        baseRef: "main",
        baseSha: BASE,
        summary: "Ship the fix"
      }
    });
    expect(created.statusCode).toBe(201);
    const waiting = created.json() as {
      state: string;
      changeSet: string;
      approvalAction: string;
      pullRequest: { number: number };
    };
    expect(waiting.state).toBe("WAITING_FOR_APPROVAL");
    expect(waiting.approvalAction).toBe("APPROVE_CHANGE_SET");
    expect(waiting.pullRequest.number).toBe(123);
    const approved = await app.inject({
      method: "POST",
      url: "/coding-missions/mission-http/approve",
      payload: { expectedChangeSetHash: waiting.changeSet }
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({ state: "COMPLETED", mergeSha: MERGE, deploymentId: "restart-1" });
    const replay = await app.inject({ method: "GET", url: "/coding-missions/mission-http" });
    expect(replay.json()).toMatchObject({ state: "COMPLETED" });
    await app.close();
  });

  it("fails closed without ports, without read scope, and for a mismatched change-set hash", async () => {
    directory = mkdtempSync(join(tmpdir(), "acs-coding-http-denied-"));
    const dbPath = join(directory, "control.db");
    const store = new SqliteWorkItemStore(dbPath);
    store.registerActor({ id: "user", actorType: "HUMAN", displayName: "user", externalRef: "local_bearer:local-dev" });
    store.close();
    const headers = { authorization: `Bearer ${auth.token}` };
    const payload = {
      missionId: "mission-http",
      repository: "example/repo",
      baseRef: "main",
      baseSha: BASE,
      summary: "Ship the fix"
    };
    const unconfigured = buildGateway({ dbPath, logger: false, auth });
    const missing = await unconfigured.inject({ method: "POST", url: "/coding-missions", headers, payload });
    expect(missing.statusCode).toBe(503);
    expect(missing.json()).toMatchObject({ code: "coding_mission_unconfigured" });
    const unlisted = await unconfigured.inject({ method: "GET", url: "/coding-missions", headers });
    expect(unlisted.statusCode).toBe(503);
    expect(unlisted.json()).toMatchObject({ code: "coding_mission_unconfigured" });
    await unconfigured.close();

    const app = buildGateway({ dbPath, logger: false, auth, codingMissionPorts: ports() });
    const anonymous = await app.inject({ method: "GET", url: "/coding-missions/mission-http" });
    expect(anonymous.statusCode).toBe(401);
    const anonymousList = await app.inject({ method: "GET", url: "/coding-missions" });
    expect(anonymousList.statusCode).toBe(401);
    const created = await app.inject({ method: "POST", url: "/coding-missions", headers, payload });
    expect(created.statusCode).toBe(201);
    const listed = await app.inject({ method: "GET", url: "/coding-missions", headers });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({
      missions: [
        expect.objectContaining({ missionId: "mission-http", state: "WAITING_FOR_APPROVAL", deploymentRequired: true })
      ]
    });
    const stale = await app.inject({
      method: "POST",
      url: "/coding-missions/mission-http/approve",
      headers,
      payload: { expectedChangeSetHash: "0".repeat(64) }
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: "coding_mission_stale_approval" });
    await app.close();
  });
});
