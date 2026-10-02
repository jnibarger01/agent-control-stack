/**
 * E2E: one real Jace Commander governed write under a mission-scoped
 * autonomous authority grant. Mirrors the DC change-set-execution recipe
 * (tests/e2e/acs-dc-mcp/change-set-execution.test.ts) but for the
 * jace_commander lane: real ACS gateway, real JC bridge, real
 * jace-commander CLI serving /jc/mcp. No human approval endpoint is used;
 * the grant supplies the authority, and an independent reviewer credential
 * performs the mandatory Step-7 verification before completion.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  SqliteWorkItemStore,
  executionPlanSubjectInputHash,
  type ChangeSetOperationPermit,
  type ChangeSetDefinition
} from "@agent-control-stack/work-items";
import { directCapabilityAdmission, E2E_ENABLED, McpHttpClient, sandbox, waitFor } from "../support/chain-harness.js";
import {
  JC_BRIDGE_AUTH_TOKEN,
  jcAccessToken,
  requireJaceCommanderBuild,
  startJcAcs,
  startJcBridge,
  startJcEdge
} from "../support/jc-harness.js";

const OPERATOR_TOKEN = "e2e-jc-operator-token";
const MISSION_TOKEN = "e2e-jc-mission-token";
const REVIEWER_TOKEN = "e2e-independent-reviewer-token";

describe.skipIf(!E2E_ENABLED)("real JC execution under a mission-scoped autonomous authority grant", () => {
  it("governs one contained write_file via the grant, with mandatory independent review", async () => {
    requireJaceCommanderBuild();
    const box = sandbox("acs-jc-change-set-");
    const acs = await startJcAcs(box, [box.workspace], {
      executionAdmission: directCapabilityAdmission(),
      additionalCredentials: [
        {
          id: "jc-mission",
          token: MISSION_TOKEN,
          actor: "agent",
          actorId: "chatgpt:jacen",
          roles: ["service"],
          scopes: ["acs:read", "acs:write"]
        },
        {
          id: "independent-reviewer",
          token: REVIEWER_TOKEN,
          actor: "agent",
          actorId: "e2e-independent-reviewer",
          roles: ["service"],
          scopes: ["acs:read", "acs:review"]
        }
      ]
    });
    let bridge: Awaited<ReturnType<typeof startJcBridge>> | undefined;
    let edge: Awaited<ReturnType<typeof startJcEdge>> | undefined;
    let client: McpHttpClient | undefined;
    const post = (url: string, payload: unknown, token = MISSION_TOKEN) =>
      acs.app.inject({
        method: "POST",
        url,
        headers: { authorization: `Bearer ${token}` },
        payload
      });
    const jcIssue = async (payload: Record<string, unknown>) => {
      const response = await fetch(`${acs.url}/jc/capability/issue`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${JC_BRIDGE_AUTH_TOKEN}`,
          "content-type": "application/json",
          "x-jc-actor": "chatgpt:jacen"
        },
        body: JSON.stringify(payload)
      });
      return { status: response.status, body: await response.json().catch(() => null) };
    };
    try {
      bridge = await startJcBridge(box, acs, [box.workspace]);
      edge = await startJcEdge(box, acs, bridge);
      client = new McpHttpClient(`${edge.origin}/jc/mcp`, () => ({
        authorization: `Bearer ${jcAccessToken(edge.origin)}`
      }));
      expect((await client.initialize()).status, edge.output()).toBe(200);

      const createMission = async (title: string) => {
        const created = await post("/work-items", {
          title,
          intent: "bounded JC write under grant",
          requester: "agent",
          target: { cwd: box.workspace },
          requestedActions: [{ kind: "fs.read", description: "plan", params: { paths: [box.workspace] } }],
          risk: "low"
        });
        expect(created.statusCode, created.body).toBe(201);
        return created.json().workItem ?? created.json();
      };
      const main = await createMission("main JC mission");
      const probe = await createMission("probe mission for direct issue assertions");

      const buildDefinition = (
        mission: { id: string },
        operationId: string,
        path: string,
        content: string
      ): ChangeSetDefinition => ({
        schemaVersion: "acs.change-set.v1",
        missionId: mission.id,
        subjectInputHash: executionPlanSubjectInputHash(mission),
        executingActorId: "chatgpt:jacen",
        objective: "one governed write",
        scope: [
          { kind: "path" as const, id: box.workspace },
          { kind: "path" as const, id: path }
        ],
        maximumPrivileges: ["fs.read", "fs.write"],
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        constraints: { maxRuntimeMs: 45_000, maxParallelOperations: 1, failureBehavior: "stop" },
        operations: [
          {
            operationId,
            runtime: "jace_commander",
            toolName: "write_file",
            action: { kind: "fs.write", description: "bounded write", params: { path, content } },
            resources: [
              { kind: "path" as const, id: box.workspace },
              { kind: "path" as const, id: path }
            ],
            requestedPrivileges: ["fs.write"],
            effect: "mutation",
            expectedSideEffects: ["write one file"],
            dependsOn: [],
            retry: { maxAttempts: 1, idempotencyKey: `write-${operationId}` }
          }
        ],
        verification: [
          {
            requirementId: `inspect-${operationId}`,
            kind: "fs_inspect",
            operationIds: [operationId],
            expectation: { path, content },
            independent: true
          }
        ]
      });

      const submitChangeSet = async (mission: { id: string }, definition: ChangeSetDefinition) => {
        const submission = await post(`/work-items/${mission.id}/change-sets`, {
          definition,
          submissionId: `one-plan-${mission.id}`,
          expectedHeadHash: null
        });
        expect(submission.statusCode, submission.body).toBe(201);
        return submission.json();
      };
      const issueGrant = async (
        mission: { id: string },
        definition: ChangeSetDefinition,
        requestId: string,
        expiresAt?: string
      ) => {
        const grant = await post(
          `/work-items/${mission.id}/authority-grants`,
          {
            requestId,
            expectedSubjectInputHash: definition.subjectInputHash,
            reason: "Delegate bounded JC write",
            definition: {
              executingActorId: definition.executingActorId,
              scope: [{ kind: "path", id: box.workspace, coverage: "descendants" }],
              toolClasses: [{ runtime: "jace_commander", toolName: "write_file" }],
              maximumPrivileges: ["fs.read", "fs.write"],
              expiresAt: expiresAt ?? definition.expiresAt,
              limits: { maxOperations: 1, maxRuntimeMs: 45_000, maxParallelOperations: 1, maxAttemptsPerOperation: 1 }
            }
          },
          OPERATOR_TOKEN
        );
        expect(grant.statusCode, grant.body).toBe(201);
        return grant.json();
      };
      const authorize = async (mission: { id: string }, manifestHash: string, grantId: string) => {
        const authorized = await post(`/work-items/${mission.id}/change-sets/authorize`, {
          grantId,
          expectedManifestHash: manifestHash
        });
        return authorized;
      };
      const permitOperation = async (
        mission: { id: string },
        manifestHash: string,
        operationId: string,
        authorizationId: string
      ) => {
        const permitted = await post(`/work-items/${mission.id}/change-sets/operations/${operationId}/permit`, {
          expectedManifestHash: manifestHash,
          authorizationId
        });
        return permitted;
      };

      // ---- main mission: grant1 -> authorize -> permit ----
      const target = join(box.workspace, "governed.txt");
      const mainDefinition = buildDefinition(main, "write", target, "governed-by-grant");
      const mainSubmission = await submitChangeSet(main, mainDefinition);
      const grant1 = await issueGrant(main, mainDefinition, "delegation-1");
      // Acceptance 2: grant explicitly allows runtime + exact tool class + path scope + fs.write.
      expect(grant1.definition.executingActorId).toBe("chatgpt:jacen");
      expect(grant1.definition.toolClasses).toEqual([{ runtime: "jace_commander", toolName: "write_file" }]);
      expect(grant1.definition.scope).toEqual([{ kind: "path", id: box.workspace, coverage: "descendants" }]);
      expect(grant1.definition.maximumPrivileges).toEqual(["fs.read", "fs.write"]);
      const auth1 = await authorize(main, mainSubmission.manifestHash, grant1.grantId);
      expect(auth1.statusCode, auth1.body).toBe(201);
      const permit1 = await permitOperation(main, mainSubmission.manifestHash, "write", auth1.json().authorizationId);
      expect(permit1.statusCode, permit1.body).toBe(201);
      const permit: ChangeSetOperationPermit = permit1.json();
      expect(permit.runtime).toBe("jace_commander");
      expect(permit.toolName).toBe("write_file");
      expect(permit.invocationHash).toBeTypeOf("string");

      // ---- probe mission: direct /jc/capability/issue assertions (grant2) ----
      const probePath = join(box.workspace, "probe.txt");
      const probeDefinition = buildDefinition(probe, "probe", probePath, "probe-content");
      const probeSubmission = await submitChangeSet(probe, probeDefinition);
      const grant2 = await issueGrant(probe, probeDefinition, "delegation-2");
      const auth2 = await authorize(probe, probeSubmission.manifestHash, grant2.grantId);
      expect(auth2.statusCode, auth2.body).toBe(201);
      const permit2Response = await permitOperation(
        probe,
        probeSubmission.manifestHash,
        "probe",
        auth2.json().authorizationId
      );
      expect(permit2Response.statusCode, permit2Response.body).toBe(201);
      const permit2: ChangeSetOperationPermit = permit2Response.json();

      // Acceptance 3: permit -> /jc/capability/issue yields acs.jc.v1 bound to the permit's invocationHash.
      const issued = await jcIssue({
        client_id: "jc-e2e-cli",
        tool: "write_file",
        argsSummary: JSON.stringify({ path: probePath, content: "probe-content" }),
        changeSetPermitId: permit2.permitId
      });
      expect(issued.status, JSON.stringify(issued.body)).toBe(200);
      expect(issued.body.decision).toBe("allow");
      expect(issued.body.invocationHash).toBe(permit2.invocationHash);
      expect(issued.body.capability.payload.version).toBe("acs.jc.v1");
      expect(issued.body.capability.payload.invocationHash).toBe(permit2.invocationHash);
      expect(issued.body.capability.keyId).toBe("e2e-jc-key");

      // Acceptance 5: wrong tool / different args with the same permit are rejected.
      const wrongTool = await jcIssue({
        client_id: "jc-e2e-cli",
        tool: "read_file",
        argsSummary: JSON.stringify({ path: probePath }),
        changeSetPermitId: permit2.permitId
      });
      expect(wrongTool.status, JSON.stringify(wrongTool.body)).toBeGreaterThanOrEqual(400);
      expect(wrongTool.body.code).toBe("change_set_permit_binding_mismatch");
      const wrongArgs = await jcIssue({
        client_id: "jc-e2e-cli",
        tool: "write_file",
        argsSummary: JSON.stringify({ path: probePath, content: "different" }),
        changeSetPermitId: permit2.permitId
      });
      expect(wrongArgs.status, JSON.stringify(wrongArgs.body)).toBeGreaterThanOrEqual(400);
      expect(wrongArgs.body.code).toBe("change_set_permit_binding_mismatch");

      // Acceptance 6: no permit/approval -> refusal; forged capability -> refusal.
      const noMeta = await client.call("write_file", { path: join(box.workspace, "no-meta.txt"), content: "x" });
      expect(noMeta.status).toBe(200);
      expect(noMeta.body.error, JSON.stringify(noMeta.body)).toBeDefined();
      const noMetaData = noMeta.body.error.data as { kind: string; acsCode: string };
      expect(noMetaData.kind).toBe("managed_authorization_required");
      expect(noMetaData.acsCode).toBe("require_approval");
      expect(existsSync(join(box.workspace, "no-meta.txt"))).toBe(false);
      const forgedDirect = new McpHttpClient(`http://127.0.0.1:${bridge.port}/mcp`, () => ({}));
      try {
        expect((await forgedDirect.initialize()).status).toBe(200);
        const forged = await forgedDirect.call("write_file", { path: join(box.workspace, "forged.txt"), content: "x" });
        expect(JSON.stringify(forged.body)).toMatch(/JC_CAPABILITY_/u);
        expect(existsSync(join(box.workspace, "forged.txt"))).toBe(false);
      } finally {
        await forgedDirect.close();
      }

      // Acceptance 7: revoked + expired grants cannot issue new operations.
      const probe3 = await post(
        `/work-items/${probe.id}/authority-grants`,
        {
          requestId: "delegation-3",
          expectedSubjectInputHash: probeDefinition.subjectInputHash,
          reason: "revoke check",
          definition: {
            executingActorId: probeDefinition.executingActorId,
            scope: [{ kind: "path", id: box.workspace, coverage: "descendants" }],
            toolClasses: [{ runtime: "jace_commander", toolName: "write_file" }],
            maximumPrivileges: ["fs.read", "fs.write"],
            expiresAt: probeDefinition.expiresAt,
            limits: { maxOperations: 1, maxRuntimeMs: 45_000, maxParallelOperations: 1, maxAttemptsPerOperation: 1 }
          }
        },
        OPERATOR_TOKEN
      );
      expect(probe3.statusCode, probe3.body).toBe(201);
      const grant3 = probe3.json();
      const auth3 = await authorize(probe, probeSubmission.manifestHash, grant3.grantId);
      expect(auth3.statusCode, auth3.body).toBe(201);
      const revoked = await post(
        `/work-items/${probe.id}/authority-grants/${grant3.grantId}/revoke`,
        { reason: "test revocation" },
        OPERATOR_TOKEN
      );
      expect(revoked.statusCode, revoked.body).toBe(200);
      const grant3After = await fetch(`${acs.url}/work-items/${probe.id}/authority-grants/${grant3.grantId}`, {
        headers: { authorization: `Bearer ${OPERATOR_TOKEN}` }
      });
      const grant3AfterJson = await grant3After.json();
      expect(grant3AfterJson.active).toBe(false);
      expect(grant3AfterJson.code).toBe("autonomous_authority_revoked");
      const permit3 = await permitOperation(probe, probeSubmission.manifestHash, "probe", auth3.json().authorizationId);
      expect(permit3.statusCode, permit3.body).toBeGreaterThanOrEqual(400);
      expect(permit3.json().code).toBe("autonomous_authority_revoked");
      const ephemeral = await createMission("ephemeral mission for grant-expiry check");
      const ephemeralDefinition = buildDefinition(
        ephemeral,
        "probe",
        join(box.workspace, "ephemeral.txt"),
        "ephemeral-content"
      );
      ephemeralDefinition.expiresAt = new Date(Date.now() + 5_000).toISOString();
      const ephemeralSubmission = await submitChangeSet(ephemeral, ephemeralDefinition);
      const grant4 = (
        await post(
          `/work-items/${ephemeral.id}/authority-grants`,
          {
            requestId: "delegation-4",
            expectedSubjectInputHash: ephemeralDefinition.subjectInputHash,
            reason: "expiry check",
            definition: {
              executingActorId: ephemeralDefinition.executingActorId,
              scope: [{ kind: "path", id: box.workspace, coverage: "descendants" }],
              toolClasses: [{ runtime: "jace_commander", toolName: "write_file" }],
              maximumPrivileges: ["fs.read", "fs.write"],
              expiresAt: ephemeralDefinition.expiresAt,
              limits: { maxOperations: 1, maxRuntimeMs: 45_000, maxParallelOperations: 1, maxAttemptsPerOperation: 1 }
            }
          },
          OPERATOR_TOKEN
        )
      ).json();
      const auth4 = await authorize(ephemeral, ephemeralSubmission.manifestHash, grant4.grantId);
      expect(auth4.statusCode, auth4.body).toBe(201);
      await new Promise((resolve) => setTimeout(resolve, 6_000));
      const permit4 = await permitOperation(
        ephemeral,
        ephemeralSubmission.manifestHash,
        "probe",
        auth4.json().authorizationId
      );
      expect(permit4.statusCode, permit4.body).toBeGreaterThanOrEqual(400);
      expect(permit4.json().code).toBe("autonomous_authority_expired");
      const grant4After = await fetch(`${acs.url}/work-items/${ephemeral.id}/authority-grants/${grant4.grantId}`, {
        headers: { authorization: "Bearer " + OPERATOR_TOKEN }
      });
      const grant4AfterJson = await grant4After.json();
      expect(grant4AfterJson.active).toBe(false);
      expect(grant4AfterJson.code).toBe("autonomous_authority_expired");

      // Acceptance 4: real /jc/mcp execution through the JC bridge.
      expect(existsSync(target)).toBe(false);
      const executed = await client.call("write_file", mainDefinition.operations[0]!.action.params, {
        acsOperationPermitId: permit.permitId
      });
      expect(executed.status, JSON.stringify(executed.body)).toBe(200);
      expect(executed.body.result?.isError, JSON.stringify(executed.body)).toBeUndefined();
      const completedChild = await waitFor(async () => {
        const detail = await acs.workItem(permit.executionWorkItemId);
        return detail.workItem.status === "succeeded" ? detail : undefined;
      });
      expect(readFileSync(target, "utf8")).toBe("governed-by-grant");
      expect(completedChild.events.map((event) => event.name)).not.toContain("verification.decision");

      // Acceptance 9: mandatory Step-7 independent verification before completion.
      const preReviewProgress = await acs.app.inject({
        method: "GET",
        url: `/work-items/${main.id}/change-sets/progress?expectedManifestHash=${mainSubmission.manifestHash}`,
        headers: { authorization: `Bearer ${OPERATOR_TOKEN}` }
      });
      expect(preReviewProgress.statusCode, preReviewProgress.body).toBe(200);
      expect(preReviewProgress.json().operations[0].status).toBe("awaiting_verification");
      const preReviewComplete = await post(`/work-items/${main.id}/change-sets/complete`, {
        expectedManifestHash: mainSubmission.manifestHash,
        authorizationId: auth1.json().authorizationId
      });
      expect(preReviewComplete.statusCode, preReviewComplete.body).toBe(409);
      expect(preReviewComplete.json().code).toBe("change_set_completion_pending");

      const progressForReview = await acs.app.inject({
        method: "GET",
        url: `/work-items/${main.id}/change-sets/progress?expectedManifestHash=${mainSubmission.manifestHash}`,
        headers: { authorization: `Bearer ${REVIEWER_TOKEN}` }
      });
      const operation = progressForReview.json().operations[0];
      const context = await fetch(`${acs.url}/work-items/${operation.executionWorkItemId}/change-set-review`, {
        headers: { authorization: `Bearer ${REVIEWER_TOKEN}` }
      });
      expect(context.status).toBe(200);
      const reviewContext = (await context.json()) as { evidence: { manifest: { observations: unknown } } };
      expect(reviewContext.evidence.manifest.observations).toBeDefined();
      expect(readFileSync(target, "utf8")).toBe("governed-by-grant");
      const reviewed = await fetch(`${acs.url}/work-items/${operation.executionWorkItemId}/change-set-review`, {
        method: "POST",
        headers: { authorization: `Bearer ${REVIEWER_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({
          attemptId: operation.attemptId,
          evidenceManifestHash: operation.evidenceManifestHash,
          verdict: "PASS",
          reason: "independent reviewer confirmed persisted evidence and file readback"
        })
      });
      expect(reviewed.status, await reviewed.text()).toBe(200);

      // A stale second use of the consumed permit is a governed dispatch denial.
      const extra = join(box.workspace, "extra.txt");
      const stalePermit = await client.call(
        "write_file",
        { path: extra, content: "not approved" },
        { acsOperationPermitId: permit.permitId }
      );
      expect(stalePermit.body.error, JSON.stringify(stalePermit.body)).toBeDefined();
      expect(existsSync(extra)).toBe(false);

      const completedMission = await post(`/work-items/${main.id}/change-sets/complete`, {
        expectedManifestHash: mainSubmission.manifestHash,
        authorizationId: auth1.json().authorizationId
      });
      expect(completedMission.statusCode, completedMission.body).toBe(200);
      expect(completedMission.json().schemaVersion).toBe("acs.change-set.completion.v1");
      const replayCompletion = await post(`/work-items/${main.id}/change-sets/complete`, {
        expectedManifestHash: mainSubmission.manifestHash,
        authorizationId: auth1.json().authorizationId
      });
      expect(replayCompletion.statusCode, replayCompletion.body).toBe(200);
      expect(replayCompletion.json()).toEqual(completedMission.json());

      const progress = await acs.app.inject({
        method: "GET",
        url: `/work-items/${main.id}/change-sets/progress?expectedManifestHash=${mainSubmission.manifestHash}`,
        headers: { authorization: `Bearer ${OPERATOR_TOKEN}` }
      });
      expect(progress.json().operations.map((entry: { status: string }) => entry.status)).toEqual(["succeeded"]);
      expect((await acs.workItem(main.id)).workItem.status).toBe("succeeded");

      // Acceptance 8 + trace: result bound to attempt/lease/fence/plan/input/action.
      const traceResponse = await fetch(`${acs.url}/work-items/${main.id}/mission-trace?limit=200`, {
        headers: { authorization: `Bearer ${OPERATOR_TOKEN}` }
      });
      expect(traceResponse.status).toBe(200);
      const trace = (await traceResponse.json()) as {
        operations: unknown[];
        events: Array<{
          event: { name: string };
          correlation: { missionId: string; operationId?: string; attemptId?: string; leaseId?: string };
          producer: Record<string, string>;
        }>;
      };
      expect(trace.operations).toHaveLength(1);
      expect(trace.events.every((entry) => entry.correlation.missionId === main.id)).toBe(true);
      expect(trace.events.map((entry) => entry.event.name)).toEqual(
        expect.arrayContaining([
          "change_set.submitted",
          "change_set.policy_evaluated",
          "change_set.operation_permitted",
          "execution_admission.bound",
          "jace_commander.capability_issued",
          "execution_attempt.result_accepted",
          "evidence.manifest_recorded",
          "change_set.dispatch_denied",
          "review.finding_recorded",
          "verification.decision",
          "change_set.completed"
        ])
      );
      const accepted = trace.events.find((entry) => entry.event.name === "execution_attempt.result_accepted")!;
      expect(accepted.correlation.attemptId).toBeDefined();
      expect(accepted.correlation.leaseId).toBeDefined();
      expect(accepted.producer["acs.process.id"]).not.toBe("unknown");

      const store = new SqliteWorkItemStore(join(box.root, "acs-jc.db"));
      try {
        // Acceptance 1: no human approval endpoint was called; grant carried the mission.
        expect(store.readEvents({ name: "change_set.approved" })).toHaveLength(0);
        expect(store.readEvents({ name: "autonomous_authority.issued" })).toHaveLength(4);
        expect(store.readEvents({ name: "autonomous_authority.revoked" })).toHaveLength(1);
        expect(store.readEvents({ name: "change_set.grant_authorized" })).toHaveLength(4);
        expect(store.readEvents().filter((event) => event.name === "change_set.operation_permitted")).toHaveLength(2);
        expect(store.readEvents().filter((event) => event.name === "execution_result.accepted")).toHaveLength(1);
        expect(store.readEvents({ name: "change_set.completed" })).toHaveLength(1);
        expect(store.getChangeSetProgress(main.id).completion).toEqual(completedMission.json());
        expect(store.verifyAuditChain().ok).toBe(true);
        const progressOps = store.getChangeSetProgress(main.id).operations[0]!;
        const attempt = store.getAttempt(progressOps.attemptId!);
        expect(attempt?.status).toBe("succeeded");
        expect(attempt?.planHash).toBeTypeOf("string");
        expect(attempt?.inputHash).toBeTypeOf("string");
        expect(attempt?.currentFencingEpoch).toBeTypeOf("number");
        const lease = store.getActiveLeaseForAttempt(progressOps.attemptId!);
        expect(lease).toBeDefined();
        const countDb = new DatabaseSync(join(box.root, "acs-jc.db"));
        try {
          expect(countDb.prepare("SELECT count(*) AS n FROM change_set_operation_permits").get()).toEqual({ n: 2 });
          expect(countDb.prepare("SELECT count(*) AS n FROM execution_attempts").get()).toEqual({ n: 2 });
          expect(countDb.prepare("SELECT count(*) AS n FROM attempt_results").get()).toEqual({ n: 1 });
        } finally {
          countDb.close();
        }
      } finally {
        store.close();
      }
    } finally {
      await client?.close();
      await edge?.stop();
      await bridge?.stop();
      await acs?.close();
      box.cleanup();
    }
  }, 60_000);
});
