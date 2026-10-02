/**
 * E2E: final full-system acceptance — ONE mission, ONE immutable Change
 * Set with two dependent operations on different runtimes (Desktop
 * Commander and Jace Commander), ONE autonomous authority grant, one
 * controlled executor restart boundary, independent review, verification,
 * completion, and a mission-wide trace.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createMissionRunnerClient } from "../../../apps/worker/src/mission-client.js";
import { runMission, runMissionOnce, type MissionRunnerOptions } from "../../../apps/worker/src/mission-runner.js";
import {
  SqliteWorkItemStore,
  executionPlanSubjectInputHash,
  type ChangeSetOperationPermit,
  type ChangeSetDefinition
} from "@agent-control-stack/work-items";
import {
  DC_ENTRY,
  E2E_ENABLED,
  accessToken,
  bridgeAuthority,
  desktopCommanderRuntimeId,
  directCapabilityAdmission,
  executorPid,
  McpHttpClient,
  requireDesktopCommanderBuild,
  sandbox,
  waitFor
} from "../support/chain-harness.js";
import { jcAccessToken, requireJaceCommanderBuild } from "../support/jc-harness.js";
import {
  COMBINED_DB,
  COMBINED_OPERATOR_TOKEN,
  COMBINED_PLANNER_TOKEN,
  COMBINED_REVIEWER_TOKEN,
  startCombinedAcs,
  startCombinedDcBridge,
  startCombinedEdge,
  startCombinedJcBridge
} from "../support/combined-harness.js";

describe.skipIf(!E2E_ENABLED)("mixed-runtime full-system acceptance", () => {
  it("proves one mission governs DC + JC operations under one grant", async () => {
    requireDesktopCommanderBuild();
    requireJaceCommanderBuild();
    const box = sandbox("acs-mixed-acceptance-");
    let dcBridge: Awaited<ReturnType<typeof startCombinedDcBridge>> | undefined;
    let jcBridge: Awaited<ReturnType<typeof startCombinedJcBridge>> | undefined;
    let edge: Awaited<ReturnType<typeof startCombinedEdge>> | undefined;
    let acs: Awaited<ReturnType<typeof startCombinedAcs>> | undefined;
    let dcClient: McpHttpClient | undefined;
    let jcClient: McpHttpClient | undefined;
    try {
      const runtimeId = await desktopCommanderRuntimeId(box);
      acs = await startCombinedAcs(box, runtimeId, {
        executionAdmission: directCapabilityAdmission(),
        additionalCredentials: [
          {
            id: "independent-reviewer",
            token: COMBINED_REVIEWER_TOKEN,
            actor: "agent",
            actorId: "e2e-independent-reviewer",
            roles: ["service"],
            scopes: ["acs:read", "acs:review"]
          }
        ]
      });
      dcBridge = await startCombinedDcBridge(box, acs);
      jcBridge = await startCombinedJcBridge(box, acs);
      edge = await startCombinedEdge(box, acs, dcBridge, jcBridge);
      dcClient = new McpHttpClient(`${edge.origin}/mcp`, () => ({
        authorization: `Bearer ${accessToken(edge!.origin, "jacen")}`
      }));
      jcClient = new McpHttpClient(`${edge.origin}/jc/mcp`, () => ({
        authorization: `Bearer ${jcAccessToken(edge!.origin)}`
      }));
      expect((await dcClient.initialize()).status, `${edge.output()}\nDCBRIDGE:\n${dcBridge.output()}`).toBe(200);
      expect((await jcClient.initialize()).status, `${edge.output()}\nJCBRIDGE:\n${jcBridge.output()}`).toBe(200);

      const created = await acs.app.inject({
        method: "POST",
        url: "/work-items",
        headers: { authorization: `Bearer ${COMBINED_PLANNER_TOKEN}` },
        payload: {
          title: "mixed-runtime mission",
          intent: "governed writes on both runtimes under one grant",
          requester: "agent",
          target: { cwd: box.workspace },
          requestedActions: [{ kind: "fs.read", description: "plan", params: { paths: [box.workspace] } }],
          risk: "low"
        }
      });
      expect(created.statusCode, created.body).toBe(201);
      const mission = created.json().workItem ?? created.json();
      const paths = [join(box.workspace, "a.txt"), join(box.workspace, "b.txt")];
      const scope = [box.workspace, ...paths].map((id) => ({ kind: "path" as const, id }));
      const definition: ChangeSetDefinition = {
        schemaVersion: "acs.change-set.v1",
        missionId: mission.id,
        subjectInputHash: executionPlanSubjectInputHash(mission),
        executingActorId: "chatgpt:jacen",
        objective: "two dependent verified writes on two runtimes",
        scope,
        maximumPrivileges: ["fs.read", "fs.write"],
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        constraints: { maxRuntimeMs: 45_000, maxParallelOperations: 1, failureBehavior: "stop" },
        operations: [
          {
            operationId: "a",
            runtime: "desktop_commander",
            toolName: "write_file",
            action: { kind: "fs.write", description: "bounded write", params: { path: paths[0], content: "approved-0" } },
            resources: scope,
            requestedPrivileges: ["fs.write"],
            effect: "mutation",
            expectedSideEffects: ["write one file"],
            dependsOn: [],
            retry: { maxAttempts: 1, idempotencyKey: "write-a" }
          },
          {
            operationId: "b",
            runtime: "jace_commander",
            toolName: "write_file",
            action: { kind: "fs.write", description: "bounded write", params: { path: paths[1], content: "approved-1" } },
            resources: scope,
            requestedPrivileges: ["fs.write"],
            effect: "mutation",
            expectedSideEffects: ["write one file"],
            dependsOn: ["a"],
            retry: { maxAttempts: 1, idempotencyKey: "write-b" }
          }
        ],
        verification: paths.map((path, index) => ({
          requirementId: `inspect-${index}`,
          kind: "fs_inspect",
          operationIds: [index ? "b" : "a"],
          expectation: { path, content: `approved-${index}` },
          independent: true
        }))
      };
      const base = `/work-items/${mission.id}/change-sets`;
      const post = (url: string, payload: unknown, token = COMBINED_PLANNER_TOKEN) =>
        acs!.app.inject({
          method: "POST",
          url,
          headers: { authorization: `Bearer ${token}` },
          payload
        });
      const submission = await post(`/work-items/${mission.id}/change-sets`, {
        definition,
        submissionId: "one-mixed-plan",
        expectedHeadHash: null
      });
      expect(submission.statusCode, submission.body).toBe(201);
      const manifestHash = submission.json().manifestHash;
      const reviewPending = async () => {
        const headers = { authorization: `Bearer ${COMBINED_REVIEWER_TOKEN}` };
        const progressResponse = await fetch(
          `${acs!.url}/work-items/${mission.id}/change-sets/progress?expectedManifestHash=${manifestHash}`,
          { headers }
        );
        expect(progressResponse.status).toBe(200);
        const progress = (await progressResponse.json()) as {
          operations: Array<{
            status: string;
            operationId: string;
            executionWorkItemId?: string;
            attemptId?: string;
            evidenceManifestHash?: string;
          }>;
        };
        for (const operation of progress.operations.filter((entry) => entry.status === "awaiting_verification")) {
          const index = operation.operationId === "a" ? 0 : 1;
          const context = await fetch(`${acs!.url}/work-items/${operation.executionWorkItemId}/change-set-review`, {
            headers
          });
          expect(context.status).toBe(200);
          const reviewContext = (await context.json()) as { evidence: { manifest: { observations: unknown } } };
          expect(reviewContext.evidence.manifest.observations).toBeDefined();
          expect(readFileSync(paths[index]!, "utf8")).toBe(`approved-${index}`);
          const reviewed = await fetch(`${acs!.url}/work-items/${operation.executionWorkItemId}/change-set-review`, {
            method: "POST",
            headers: { ...headers, "content-type": "application/json" },
            body: JSON.stringify({
              attemptId: operation.attemptId,
              evidenceManifestHash: operation.evidenceManifestHash,
              verdict: "PASS",
              reason: "separate reviewer confirmed persisted evidence and file readback"
            })
          });
          expect(reviewed.status, await reviewed.text()).toBe(200);
        }
      };
      const reviewedPortsClient = () => {
        const connection = createMissionRunnerClient({
          gatewayUrl: acs!.url,
          gatewayToken: COMBINED_PLANNER_TOKEN,
          runtimes: {
            desktop_commander: { url: `${edge!.origin}/mcp`, token: accessToken(edge!.origin, "jacen") },
            jace_commander: { url: `${edge!.origin}/jc/mcp`, token: jcAccessToken(edge!.origin) }
          }
        });
        const request = connection.ports.request;
        connection.ports.request = async (...args) => {
          if (args[0] === "GET" && args[1].includes("/progress")) await reviewPending();
          return request(...args);
        };
        return connection;
      };

      const grant = await post(
        `/work-items/${mission.id}/authority-grants`,
        {
          requestId: "human-mission-delegation",
          expectedSubjectInputHash: definition.subjectInputHash,
          reason: "Delegate bounded two-runtime mission",
          definition: {
            executingActorId: definition.executingActorId,
            scope: [{ kind: "path", id: box.workspace, coverage: "descendants" }],
            toolClasses: [
              { runtime: "desktop_commander", toolName: "write_file" },
              { runtime: "jace_commander", toolName: "write_file" }
            ],
            maximumPrivileges: ["fs.read", "fs.write"],
            expiresAt: definition.expiresAt,
            limits: { maxOperations: 2, maxRuntimeMs: 45_000, maxParallelOperations: 1, maxAttemptsPerOperation: 1 }
          }
        },
        COMBINED_OPERATOR_TOKEN
      );
      expect(grant.statusCode, grant.body).toBe(201);
      const grantId = grant.json().grantId;
      const authorize = await post(`${base}/authorize`, { grantId, expectedManifestHash: manifestHash });
      expect(authorize.statusCode, authorize.body).toBe(201);
      const authorizationId = authorize.json().authorizationId;

      // No per-operation human approval ever happened.
      const approvedEventsEarly = new SqliteWorkItemStore(join(box.root, COMBINED_DB));
      try {
        expect(approvedEventsEarly.readEvents({ name: "change_set.approved" })).toHaveLength(0);
      } finally {
        approvedEventsEarly.close();
      }
      const premature = await post(`${base}/complete`, {
        expectedManifestHash: manifestHash,
        authorizationId
      });
      expect(premature.statusCode).toBe(409);
      expect(premature.json().code).toBe("change_set_completion_pending");

      const permits: ChangeSetOperationPermit[] = [];
      for (const operationId of ["a", "b"]) {
        const permitted = await post(`${base}/operations/${operationId}/permit`, {
          expectedManifestHash: manifestHash,
          authorizationId
        });
        expect(permitted.statusCode, permitted.body).toBe(201);
        permits.push(permitted.json());
      }
      expect(permits[0]!.runtime).toBe("desktop_commander");
      expect(permits[1]!.runtime).toBe("jace_commander");

      // Dependency ordering is enforced: b's jump ahead with its own permit is denied.
      const prematureB = await jcClient.call("write_file", definition.operations[1]!.action.params, {
        acsOperationPermitId: permits[1]!.permitId
      });
      expect(prematureB.body.error, JSON.stringify(prematureB.body)).toBeDefined();
      expect(existsSync(paths[1]!)).toBe(false);

      const options: MissionRunnerOptions = {
        missionId: mission.id,
        authority: { grantId },
        expectedManifestHash: manifestHash
      };
      const firstClient = reviewedPortsClient();
      try {
        const tick1 = await runMissionOnce(firstClient.ports, options);
        expect(tick1.operationId, JSON.stringify(tick1)).toBe("a");
        expect(["progressed", "awaiting_results"]).toContain(tick1.status);
        await waitFor(async () =>
          (await acs!.workItem(permits[0]!.executionWorkItemId)).workItem.status === "succeeded" ? true : undefined
        );
        await reviewPending();
        expect(readFileSync(paths[0]!, "utf8")).toBe("approved-0");

        // ---- controlled restart boundary: kill the DC executor ----
        const oldPid = executorPid(box);
        expect(oldPid).toBeGreaterThan(0);
        expect(readFileSync(`/proc/${oldPid}/cmdline`, "utf8").split("\0")).toContain(DC_ENTRY);
        const spawnCount = (await bridgeAuthority(dcBridge!)).bridge.spawnCount;
        process.kill(oldPid!, "SIGKILL");
        await waitFor(async () => ((await bridgeAuthority(dcBridge!)).bridge.spawnCount > spawnCount ? true : undefined));
        const stale = await dcClient!.post({ jsonrpc: "2.0", id: 900, method: "ping" });
        expect(stale.status).not.toBe(200);
        await dcClient!.close();
        dcClient = new McpHttpClient(`${edge!.origin}/mcp`, () => ({
          authorization: `Bearer ${accessToken(edge!.origin, "jacen")}`
        }));
        await waitFor(async () => {
          const attached = await dcClient!.initialize();
          return attached.status === 200 ? attached : undefined;
        }, 30_000);
        const newPid = executorPid(box);
        expect(newPid).toBeGreaterThan(0);
        expect(newPid).not.toBe(oldPid);
        // a's accepted result is durable; the restart did not fork it.
        expect((await acs!.workItem(permits[0]!.executionWorkItemId)).workItem.status).toBe("succeeded");
        expect(readFileSync(paths[0]!, "utf8")).toBe("approved-0");
        expect(existsSync(paths[1]!)).toBe(false);
      } finally {
        await firstClient.close();
      }

      // Stale reuse of the consumed permit is denied; no mutation.
      const reused = await dcClient!.call(
        "write_file",
        { path: join(box.workspace, "extra.txt"), content: "not approved" },
        { acsOperationPermitId: permits[0]!.permitId }
      );
      expect(reused.body.error, JSON.stringify(reused.body)).toBeDefined();
      expect(existsSync(join(box.workspace, "extra.txt"))).toBe(false);

      // Resume with fresh process-local state; only b may run.
      const resumedClient = reviewedPortsClient();
      try {
        const resumed = await runMission(resumedClient.ports, { ...options, maxRuntimeMs: 10_000, pollIntervalMs: 50 });
        const diagnostic = new SqliteWorkItemStore(join(box.root, COMBINED_DB));
        let failureContext: unknown;
        try {
          failureContext = {
            resumed,
            progress: diagnostic.getChangeSetProgress(mission.id),
            children: permits.map((permit) => {
              const child = diagnostic.get(permit.executionWorkItemId);
              return { id: child?.id, status: child?.status, outcome: child?.result?.outcome };
            })
          };
        } finally {
          diagnostic.close();
        }
        expect(resumed.status, JSON.stringify(failureContext)).toBe("completed");
        expect(resumed.completion?.operations.map((operation) => operation.operationId)).toEqual(["a", "b"]);
      } finally {
        await resumedClient.close();
      }
      expect(readFileSync(paths[0]!, "utf8")).toBe("approved-0");
      expect(readFileSync(paths[1]!, "utf8")).toBe("approved-1");

      const completedMission = await post(`${base}/complete`, {
        expectedManifestHash: manifestHash,
        authorizationId
      });
      expect(completedMission.statusCode, completedMission.body).toBe(200);
      expect(completedMission.json().schemaVersion).toBe("acs.change-set.completion.v1");
      const replayCompletion = await post(`${base}/complete`, {
        expectedManifestHash: manifestHash,
        authorizationId
      });
      expect(replayCompletion.statusCode, replayCompletion.body).toBe(200);
      expect(replayCompletion.json()).toEqual(completedMission.json());

      const progress = await acs!.app.inject({
        method: "GET",
        url: `${base}/progress?expectedManifestHash=${manifestHash}`,
        headers: { authorization: `Bearer ${COMBINED_PLANNER_TOKEN}` }
      });
      expect(progress.json().operations.map((entry: { status: string }) => entry.status)).toEqual([
        "succeeded",
        "succeeded"
      ]);
      expect((await acs!.workItem(mission.id)).workItem.status).toBe("succeeded");

      const traceResponse = await fetch(`${acs!.url}/work-items/${mission.id}/mission-trace?limit=200`, {
        headers: { authorization: `Bearer ${COMBINED_PLANNER_TOKEN}` }
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
      expect(trace.operations).toHaveLength(2);
      expect(trace.events.every((entry) => entry.correlation.missionId === mission.id)).toBe(true);
      expect(trace.events.map((entry) => entry.event.name)).toEqual(
        expect.arrayContaining([
          "change_set.submitted",
          "change_set.policy_evaluated",
          "change_set.operation_permitted",
          "execution_admission.bound",
          "desktop_commander.capability_issued",
          "jace_commander.capability_issued",
          "execution_attempt.result_accepted",
          "evidence.manifest_recorded",
          "change_set.dispatch_denied",
          "review.finding_recorded",
          "verification.decision",
          "change_set.completed"
        ])
      );
      for (const operationId of ["a", "b"]) {
        const observed = trace.events.find(
          (entry) =>
            entry.event.name === "execution_attempt.result_accepted" && entry.correlation.operationId === operationId
        )!;
        expect(observed.correlation.attemptId).toBeDefined();
        expect(observed.correlation.leaseId).toBeDefined();
        expect(observed.producer["acs.process.id"]).not.toBe("unknown");
      }

      const store = new SqliteWorkItemStore(join(box.root, COMBINED_DB));
      try {
        expect(store.readEvents({ name: "change_set.approved" })).toHaveLength(0);
        expect(store.readEvents({ name: "autonomous_authority.issued" })).toHaveLength(1);
        expect(store.readEvents({ name: "change_set.grant_authorized" })).toHaveLength(1);
        expect(store.readEvents().filter((event) => event.name === "change_set.operation_permitted")).toHaveLength(2);
        expect(store.readEvents().filter((event) => event.name === "execution_result.accepted")).toHaveLength(2);
        expect(store.readEvents({ name: "change_set.completed" })).toHaveLength(1);
        expect(store.getChangeSetProgress(mission.id).completion).toEqual(completedMission.json());
        expect(store.verifyAuditChain().ok).toBe(true);
        const countDb = new DatabaseSync(join(box.root, COMBINED_DB));
        try {
          expect(countDb.prepare("SELECT count(*) AS n FROM change_set_operation_permits").get()).toEqual({ n: 2 });
          expect(countDb.prepare("SELECT count(*) AS n FROM execution_attempts").get()).toEqual({ n: 2 });
          expect(countDb.prepare("SELECT count(*) AS n FROM attempt_results").get()).toEqual({ n: 2 });
        } finally {
          countDb.close();
        }
      } finally {
        store.close();
      }
    } finally {
      await dcClient?.close();
      await jcClient?.close();
      await edge?.stop();
      await jcBridge?.stop();
      await dcBridge?.stop();
      await acs?.close();
      box.cleanup();
    }
  }, 90_000);
});
