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
  E2E_ENABLED,
  DC_ENTRY,
  bridgeAuthority,
  executorPid,
  McpHttpClient,
  accessToken,
  desktopCommanderRuntimeId,
  requireDesktopCommanderBuild,
  sandbox,
  startAcs,
  startBridge,
  startEdge,
  waitFor
} from "../support/chain-harness.js";

describe.skipIf(!E2E_ENABLED)("real governed Change Set execution", () => {
  it.each([
    { authorityMode: "human approval", driver: "manual" },
    { authorityMode: "autonomous grant", driver: "manual" },
    { authorityMode: "human approval", driver: "durable runner" },
    { authorityMode: "autonomous grant", driver: "durable runner" },
    { authorityMode: "human approval", driver: "executor crash" },
    { authorityMode: "autonomous grant", driver: "executor crash" },
    { authorityMode: "human approval", driver: "stale dispatch" },
    { authorityMode: "autonomous grant", driver: "stale dispatch" },
    { authorityMode: "human approval", driver: "concurrent runners" },
    { authorityMode: "autonomous grant", driver: "concurrent runners" },
    { authorityMode: "human approval", driver: "in-flight lease loss" },
    { authorityMode: "autonomous grant", driver: "in-flight lease loss" }
  ])(
    "governs two dependent writes under $authorityMode using $driver",
    async ({ authorityMode, driver }) => {
      requireDesktopCommanderBuild();
      const box = sandbox("acs-change-set-real-execution-");
      let releaseResult!: () => void;
      const resultBarrier = new Promise<void>((resolve) => {
        releaseResult = resolve;
      });
      let resultHeld = false;
      let lateResultStatus: number | undefined;
      const acs = await startAcs(box, await desktopCommanderRuntimeId(box), {
        beforeListen:
          driver === "in-flight lease loss"
            ? (app) => {
                app.addHook("onRequest", async (request) => {
                  if (request.method === "POST" && request.url.endsWith("/results")) {
                    resultHeld = true;
                    await resultBarrier;
                  }
                });
                app.addHook("onResponse", async (request, reply) => {
                  if (request.method === "POST" && request.url.endsWith("/results"))
                    lateResultStatus = reply.statusCode;
                });
              }
            : undefined,
        additionalCredentials: [
          {
            id: "independent-reviewer",
            token: "e2e-independent-reviewer-token",
            actor: "agent",
            actorId: "e2e-independent-reviewer",
            roles: ["service"],
            scopes: ["acs:read", "acs:review"]
          },
          {
            id: "planner",
            token: "e2e-planner-token",
            actor: "agent",
            actorId: "chatgpt:e2e-user",
            roles: ["service"],
            scopes: ["acs:read", "acs:write"]
          }
        ]
      });
      let bridge: Awaited<ReturnType<typeof startBridge>> | undefined;
      let edge: Awaited<ReturnType<typeof startEdge>> | undefined;
      let client: McpHttpClient | undefined;
      const post = (url: string, payload: unknown, human = false) =>
        acs.app.inject({
          method: "POST",
          url,
          headers: { authorization: `Bearer ${human ? "e2e-operator-token" : "e2e-planner-token"}` },
          payload
        });
      try {
        bridge = await startBridge(box, acs);
        edge = await startEdge(box, acs, bridge);
        client = new McpHttpClient(`${edge.origin}/mcp`, () => ({
          authorization: `Bearer ${accessToken(edge!.origin)}`
        }));
        const initialized = await client.initialize();
        expect(initialized.status, `${edge.output()}\nBRIDGE:\n${bridge.output()}`).toBe(200);
        const created = await post("/work-items", {
          title: "two-file mission",
          intent: "write and verify two bounded files",
          requester: "agent",
          target: { cwd: box.workspace },
          requestedActions: [{ kind: "fs.read", description: "plan", params: { paths: [box.workspace] } }],
          risk: "low"
        });
        expect(created.statusCode, created.body).toBe(201);
        const mission = created.json().workItem ?? created.json();
        const paths = [join(box.workspace, "a.txt"), join(box.workspace, "b.txt")];
        const scope = [box.workspace, ...paths].map((id) => ({ kind: "path" as const, id }));
        const definition: ChangeSetDefinition = {
          schemaVersion: "acs.change-set.v1",
          missionId: mission.id,
          subjectInputHash: executionPlanSubjectInputHash(mission),
          executingActorId: "chatgpt:e2e-user",
          objective: "two dependent verified writes",
          scope,
          maximumPrivileges: ["fs.write"],
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          constraints: { maxRuntimeMs: 45_000, maxParallelOperations: 1, failureBehavior: "stop" },
          operations: paths.map((path, index) => ({
            operationId: index ? "b" : "a",
            runtime: "desktop_commander",
            toolName: "write_file",
            action: { kind: "fs.write", description: "bounded write", params: { path, content: `approved-${index}` } },
            resources: scope,
            requestedPrivileges: ["fs.write"],
            effect: "mutation",
            expectedSideEffects: ["write one file"],
            dependsOn: index ? ["a"] : [],
            retry: { maxAttempts: 1, idempotencyKey: `write-${index}` }
          })),
          verification: paths.map((path, index) => ({
            requirementId: `inspect-${index}`,
            kind: "fs_inspect",
            operationIds: [index ? "b" : "a"],
            expectation: { path, content: `approved-${index}` },
            independent: true
          }))
        };
        const url = `/work-items/${mission.id}/change-sets`;
        const submission = await post(url, { definition, submissionId: "one-plan", expectedHeadHash: null });
        expect(submission.statusCode, submission.body).toBe(201);
        let selector: { approvalId: string } | { authorizationId: string };
        let runnerAuthority: MissionRunnerOptions["authority"];
        if (authorityMode === "autonomous grant") {
          const grant = await post(
            `/work-items/${mission.id}/authority-grants`,
            {
              requestId: "human-mission-delegation",
              expectedSubjectInputHash: definition.subjectInputHash,
              reason: "Delegate bounded two-file mission",
              definition: {
                executingActorId: definition.executingActorId,
                scope: [{ kind: "path", id: box.workspace, coverage: "descendants" }],
                toolClasses: [{ runtime: "desktop_commander", toolName: "write_file" }],
                maximumPrivileges: ["fs.read", "fs.write"],
                expiresAt: definition.expiresAt,
                limits: { maxOperations: 2, maxRuntimeMs: 45_000, maxParallelOperations: 1, maxAttemptsPerOperation: 1 }
              }
            },
            true
          );
          expect(grant.statusCode, grant.body).toBe(201);
          const authorized = await post(`${url}/authorize`, {
            grantId: grant.json().grantId,
            expectedManifestHash: submission.json().manifestHash
          });
          expect(authorized.statusCode, authorized.body).toBe(201);
          selector = { authorizationId: authorized.json().authorizationId };
          runnerAuthority = { grantId: grant.json().grantId };
        } else {
          const approved = await post(
            `${url}/approve`,
            {
              expectedManifestHash: submission.json().manifestHash,
              requestId: "one-human-review",
              reason: "Approve exact bounded writes"
            },
            true
          );
          expect(approved.statusCode, approved.body).toBe(201);
          selector = { approvalId: approved.json().approvalId };
          runnerAuthority = { approvalId: approved.json().approvalId };
        }
        const permits: ChangeSetOperationPermit[] = [];
        const refreshPermits = () => {
          const reader = new SqliteWorkItemStore(join(box.root, "acs.db"));
          try {
            for (const [index, operationId] of ["a", "b"].entries()) {
              const permit = reader.getChangeSetOperationPermitForOperation(
                mission.id,
                submission.json().manifestHash,
                operationId
              );
              if (permit) permits[index] = permit;
            }
          } finally {
            reader.close();
          }
        };
        if (driver !== "concurrent runners") {
          for (const operationId of ["a", "b"]) {
            const permitted = await post(`${url}/operations/${operationId}/permit`, {
              expectedManifestHash: submission.json().manifestHash,
              ...selector
            });
            expect(permitted.statusCode, permitted.body).toBe(201);
            permits.push(permitted.json());
          }
        }
        expect(paths.some(existsSync)).toBe(false);
        const prematureCompletion = await post(`${url}/complete`, {
          expectedManifestHash: submission.json().manifestHash,
          ...selector
        });
        expect(prematureCompletion.statusCode, prematureCompletion.body).toBe(409);
        expect(prematureCompletion.json().code).toBe("change_set_completion_pending");
        if (driver !== "concurrent runners") {
          const premature = await client.call("write_file", definition.operations[1]!.action.params, {
            acsOperationPermitId: permits[1]!.permitId
          });
          expect(premature.body.error, JSON.stringify(premature.body)).toBeDefined();
        }
        expect(existsSync(paths[1]!)).toBe(false);
        // A separate reviewer service reads the durable machine evidence and
        // actual files. Its credential is never given to the mission runner.
        const reviewPending = async () => {
          const headers = { authorization: "Bearer e2e-independent-reviewer-token" };
          const progressResponse = await fetch(
            `${acs.url}/work-items/${mission.id}/change-sets/progress?expectedManifestHash=${submission.json().manifestHash}`,
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
            const context = await fetch(`${acs.url}/work-items/${operation.executionWorkItemId}/change-set-review`, {
              headers
            });
            expect(context.status).toBe(200);
            const reviewContext = (await context.json()) as { evidence: { manifest: { observations: unknown } } };
            expect(reviewContext.evidence.manifest.observations).toBeDefined();
            expect(readFileSync(paths[index]!, "utf8")).toBe(`approved-${index}`);
            const reviewed = await fetch(`${acs.url}/work-items/${operation.executionWorkItemId}/change-set-review`, {
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
        if (driver !== "manual") {
          const config = {
            gatewayUrl: acs.url,
            gatewayToken: "e2e-planner-token",
            runtimes: { desktop_commander: { url: `${edge.origin}/mcp`, token: accessToken(edge.origin) } }
          };
          const createReviewedClient = () => {
            const connection = createMissionRunnerClient(config);
            const request = connection.ports.request;
            connection.ports.request = async (...args) => {
              if (args[0] === "GET" && args[1].includes("/progress")) await reviewPending();
              return request(...args);
            };
            return connection;
          };
          const options = {
            missionId: mission.id,
            authority: runnerAuthority,
            expectedManifestHash: submission.json().manifestHash
          };
          const raceOperation = async (primary: ReturnType<typeof createMissionRunnerClient>, operationId: string) => {
            const peer = createReviewedClient();
            let releaseRace!: () => void;
            const dispatchBarrier = new Promise<void>((resolve) => {
              releaseRace = resolve;
            });
            const seenPermits: string[] = [];
            const racingPorts = (ports: typeof primary.ports) => ({
              ...ports,
              async invoke(...args: Parameters<typeof ports.invoke>) {
                seenPermits.push(args[3]);
                if (seenPermits.length === 2) releaseRace();
                await dispatchBarrier;
                return ports.invoke(...args);
              }
            });
            try {
              const ticks = await Promise.all([
                runMissionOnce(racingPorts(primary.ports), options),
                runMissionOnce(racingPorts(peer.ports), options)
              ]);
              expect(seenPermits).toHaveLength(2);
              expect(new Set(seenPermits).size).toBe(1);
              expect(ticks.every((tick) => ["progressed", "awaiting_results", "completed"].includes(tick.status))).toBe(
                true
              );
              refreshPermits();
              expect(seenPermits[0]).toBe(permits[operationId === "a" ? 0 : 1]!.permitId);
            } finally {
              releaseRace();
              await peer.close();
            }
          };
          const firstClient = createReviewedClient();
          try {
            if (driver === "concurrent runners") {
              await raceOperation(firstClient, "a");
            } else {
              const firstTick = await runMissionOnce(firstClient.ports, options);
              expect(firstTick.operationId).toBe("a");
              expect(["progressed", "awaiting_results"]).toContain(firstTick.status);
            }
            if (driver === "in-flight lease loss") {
              await waitFor(() => (resultHeld ? true : undefined));
              // The actual runtime wrote A, but its result has not entered ACS.
              expect(readFileSync(paths[0]!, "utf8")).toBe("approved-0");
              expect(existsSync(paths[1]!)).toBe(false);
              const before = new SqliteWorkItemStore(join(box.root, "acs.db"));
              try {
                const progress = before.getChangeSetProgress(mission.id);
                expect(progress.operations[0]!.status).toBe("running");
                const attemptId = progress.operations[0]!.attemptId!;
                expect(before.getVerificationDecision(attemptId)).toBeUndefined();
                const lease = before.getActiveLeaseForAttempt(attemptId)!;
                expect(lease.status).toBe("active");
                // Use the store's injected expiry clock in this isolated DB.
                expect(before.failExpiredLeases(new Date(Date.parse(lease.expiresAt) + 1))).toHaveLength(1);
                expect(before.getAttempt(attemptId)?.status).toBe("unknown");
                expect(before.getChangeSetProgress(mission.id).operations[0]!.status).toBe("needs_reconciliation");
              } finally {
                before.close();
              }
              releaseResult();
              await waitFor(() => (lateResultStatus !== undefined ? true : undefined));
              expect(lateResultStatus).toBeGreaterThanOrEqual(400);
              expect(lateResultStatus).toBeLessThan(500);
              for (let tick = 0; tick < 2; tick++) {
                const stopped = await runMissionOnce(firstClient.ports, options);
                expect(stopped.status).toBe("needs_reconciliation");
              }
              const refused = await post(`${url}/complete`, {
                expectedManifestHash: submission.json().manifestHash,
                ...selector
              });
              expect(refused.statusCode).toBe(409);
              const after = new SqliteWorkItemStore(join(box.root, "acs.db"));
              const db = new DatabaseSync(join(box.root, "acs.db"));
              try {
                expect(after.getChangeSetProgress(mission.id).operations.map((op) => op.status)).toEqual([
                  "needs_reconciliation",
                  "not_started"
                ]);
                expect(db.prepare("SELECT count(*) AS n FROM execution_attempts").get()).toEqual({ n: 1 });
                expect(db.prepare("SELECT count(*) AS n FROM attempt_results").get()).toEqual({ n: 0 });
                expect(after.readEvents({ name: "change_set.completed" })).toHaveLength(0);
                expect(after.verifyAuditChain().ok).toBe(true);
                expect(readFileSync(paths[0]!, "utf8")).toBe("approved-0");
                expect(existsSync(paths[1]!)).toBe(false);
              } finally {
                db.close();
                after.close();
              }
              return;
            }
            await waitFor(async () =>
              (await acs.workItem(permits[0].executionWorkItemId)).workItem.status === "succeeded" ? true : undefined
            );
            await reviewPending();
          } finally {
            await firstClient.close();
          }
          if (["executor crash", "stale dispatch"].includes(driver)) {
            const oldPid = executorPid(box);
            expect(oldPid).toBeGreaterThan(0);
            // Only kill this test's managed child, identified by its isolated
            // executor lock and executable arguments. Never touch host services.
            expect(readFileSync(`/proc/${oldPid}/cmdline`, "utf8").split("\0")).toContain(DC_ENTRY);
            const spawnCount = (await bridgeAuthority(bridge)).bridge.spawnCount;
            process.kill(oldPid!, "SIGKILL");
            await waitFor(async () =>
              (await bridgeAuthority(bridge!)).bridge.spawnCount > spawnCount ? true : undefined
            );
            if (driver === "stale dispatch") {
              const stale = await client.call("write_file", definition.operations[1]!.action.params, {
                acsOperationPermitId: permits[1].permitId
              });
              expect(stale.status).not.toBe(200);
              await waitFor(async () =>
                (await acs.workItem(permits[1].executionWorkItemId)).workItem.status === "failed" ? true : undefined
              );
              const stopped = await runMissionOnce(firstClient.ports, options);
              expect(stopped.status).toBe("blocked");
              expect(existsSync(paths[1]!)).toBe(false);
              expect(readFileSync(paths[0]!, "utf8")).toBe("approved-0");
              const refused = await post(`${url}/complete`, {
                expectedManifestHash: submission.json().manifestHash,
                ...selector
              });
              expect(refused.statusCode).toBe(409);
              const evidence = new SqliteWorkItemStore(join(box.root, "acs.db"));
              try {
                expect(evidence.getChangeSetProgress(mission.id).operations.map((op) => op.status)).toEqual([
                  "succeeded",
                  "failed"
                ]);
                expect(evidence.readEvents({ name: "execution_result.accepted" })).toHaveLength(2);
                expect(evidence.readEvents({ name: "change_set.completed" })).toHaveLength(0);
                expect(evidence.verifyAuditChain().ok).toBe(true);
              } finally {
                evidence.close();
              }
              return;
            }
            const stale = await client.post({ jsonrpc: "2.0", id: 900, method: "ping" });
            expect(stale.status).not.toBe(200);
            expect(existsSync(paths[1]!)).toBe(false);
            await client.close();
            client = new McpHttpClient(`${edge.origin}/mcp`, () => ({
              authorization: `Bearer ${accessToken(edge!.origin)}`
            }));
            await waitFor(async () => {
              const attached = await client!.initialize();
              return attached.status === 200 ? attached : undefined;
            }, 30_000);
            const newPid = executorPid(box);
            expect(newPid).toBeGreaterThan(0);
            expect(newPid).not.toBe(oldPid);
            expect((await acs.workItem(permits[0].executionWorkItemId)).workItem.status).toBe("succeeded");
          }
          // Lose every process-local cursor and MCP session, then recover from
          // canonical ACS results. Operation A must not execute a second time.
          const resumedClient = createReviewedClient();
          try {
            if (driver === "concurrent runners") {
              await raceOperation(resumedClient, "b");
              await waitFor(async () =>
                (await acs.workItem(permits[1]!.executionWorkItemId)).workItem.status === "succeeded" ? true : undefined
              );
            }
            const resumed = await runMission(resumedClient.ports, {
              ...options,
              maxRuntimeMs: 10_000,
              pollIntervalMs: 50
            });
            const diagnostic = new SqliteWorkItemStore(join(box.root, "acs.db"));
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
          expect(paths.map((path) => readFileSync(path, "utf8"))).toEqual(["approved-0", "approved-1"]);
        } else
          for (let index = 0; index < 2; index++) {
            const response = await client.call("write_file", definition.operations[index]!.action.params, {
              acsOperationPermitId: permits[index].permitId
            });
            expect(response.status, JSON.stringify(response.body)).toBe(200);
            expect(response.body.result?.isError, JSON.stringify(response.body)).toBeUndefined();
            const completed = await waitFor(async () => {
              const detail = await acs.workItem(permits[index].executionWorkItemId);
              return detail.workItem.status === "succeeded" ? detail : undefined;
            });
            expect(readFileSync(paths[index]!, "utf8")).toBe(`approved-${index}`);
            expect(completed.events.map((event) => event.name)).not.toContain("verification.decision");
            await reviewPending();
          }
        const extra = join(box.workspace, "extra.txt");
        const rejected = await client.call(
          "write_file",
          { path: extra, content: "not approved" },
          { acsOperationPermitId: permits[0].permitId }
        );
        expect(rejected.body.error, JSON.stringify(rejected.body)).toBeDefined();
        expect(existsSync(extra)).toBe(false);
        const completedMission = await post(`${url}/complete`, {
          expectedManifestHash: submission.json().manifestHash,
          ...selector
        });
        expect(completedMission.statusCode, completedMission.body).toBe(200);
        expect(completedMission.json().schemaVersion).toBe("acs.change-set.completion.v1");
        const replayCompletion = await post(`${url}/complete`, {
          expectedManifestHash: submission.json().manifestHash,
          ...selector
        });
        expect(replayCompletion.statusCode, replayCompletion.body).toBe(200);
        expect(replayCompletion.json()).toEqual(completedMission.json());
        const progress = await acs.app.inject({
          method: "GET",
          url: `${url}/progress?expectedManifestHash=${submission.json().manifestHash}`,
          headers: { authorization: "Bearer e2e-planner-token" }
        });
        expect(progress.statusCode, progress.body).toBe(200);
        expect(progress.json().operations.map((operation: { status: string }) => operation.status)).toEqual([
          "succeeded",
          "succeeded"
        ]);
        expect(progress.json().completion).toEqual(completedMission.json());
        expect((await acs.workItem(mission.id)).workItem.status).toBe("succeeded");
        const traceResponse = await fetch(`${acs.url}/work-items/${mission.id}/mission-trace?limit=200`, {
          headers: { authorization: "Bearer e2e-planner-token" }
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

        const store = new SqliteWorkItemStore(join(box.root, "acs.db"));
        try {
          expect(store.readEvents({ name: "change_set.approved" })).toHaveLength(
            authorityMode === "human approval" ? 1 : 0
          );
          expect(store.readEvents({ name: "autonomous_authority.issued" })).toHaveLength(
            authorityMode === "autonomous grant" ? 1 : 0
          );
          expect(store.readEvents({ name: "change_set.grant_authorized" })).toHaveLength(
            authorityMode === "autonomous grant" ? 1 : 0
          );
          expect(store.list()).toHaveLength(3);
          const countDb = new DatabaseSync(join(box.root, "acs.db"));
          try {
            expect(countDb.prepare("SELECT count(*) AS n FROM change_set_operation_permits").get()).toEqual({ n: 2 });
            expect(countDb.prepare("SELECT count(*) AS n FROM execution_attempts").get()).toEqual({ n: 2 });
            expect(countDb.prepare("SELECT count(*) AS n FROM attempt_results").get()).toEqual({ n: 2 });
          } finally {
            countDb.close();
          }
          expect(store.readEvents().filter((event) => event.name === "change_set.operation_permitted")).toHaveLength(2);
          expect(store.readEvents().filter((event) => event.name === "execution_result.accepted")).toHaveLength(2);
          expect(store.readEvents({ name: "change_set.completed" })).toHaveLength(1);
          expect(store.getChangeSetProgress(mission.id).completion).toEqual(completedMission.json());
          expect(store.verifyAuditChain().ok).toBe(true);
        } finally {
          store.close();
        }
      } finally {
        releaseResult();
        await client?.close();
        await edge?.stop();
        await bridge?.stop();
        await acs.close();
        box.cleanup();
      }
    },
    60_000
  );
});
