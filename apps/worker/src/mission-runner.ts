import { ControlStackError, stableHash } from "@agent-control-stack/shared";
import {
  changeSetRecordSchema,
  changeSetManifestHash,
  changeSetDefinitionSchema,
  changeSetOperationPermitSchema,
  changeSetProgressSchema,
  changeSetCompletionSchema,
  executionPlanSubjectInputHash,
  workItemSchema,
  type ChangeSetDefinition,
  type ChangeSetCompletion,
  type WorkItem
} from "@agent-control-stack/work-items";

export interface MissionGatewayResponse {
  status: number;
  body: unknown;
}
/** Both ports must use authenticated governed endpoints. Neither can grant authority. */
export interface MissionRunnerPorts {
  request(method: "GET" | "POST", path: string, body?: unknown): Promise<MissionGatewayResponse>;
  invoke(
    runtime: "desktop_commander" | "jace_commander",
    name: string,
    args: Record<string, unknown>,
    permitId: string
  ): Promise<void>;
}
export interface MissionRunnerOptions {
  missionId: string;
  authority?: { grantId: string } | { approvalId: string };
  /** An external agent/planner proposes data; ACS derives all policy/authority. */
  plan?: (mission: WorkItem) => Promise<ChangeSetDefinition>;
  expectedManifestHash?: string;
}
export interface MissionRunnerResult {
  missionId: string;
  status:
    | "awaiting_plan"
    | "awaiting_approval"
    | "awaiting_results"
    | "awaiting_verification"
    | "progressed"
    | "needs_reconciliation"
    | "blocked"
    | "completed";
  manifestHash?: string;
  operationId?: string;
  code?: string;
  completion?: ChangeSetCompletion;
}

function requireResponse(response: MissionGatewayResponse): unknown {
  if (response.status < 200 || response.status >= 300)
    throw new ControlStackError("mission_gateway_rejected", "ACS rejected the governed mission request");
  return response.body;
}

/**
 * One resumable tick. All progress, dispatch claims and accepted results live in
 * ACS. Recreating this client cannot forget a completed mutation or replay a
 * running/unknown attempt. Concurrent clients still rely on ACS lease fencing.
 */
export async function runMissionOnce(
  ports: MissionRunnerPorts,
  options: MissionRunnerOptions
): Promise<MissionRunnerResult> {
  const result = (
    status: MissionRunnerResult["status"],
    extra: Omit<Partial<MissionRunnerResult>, "status" | "missionId"> = {}
  ): MissionRunnerResult => ({ missionId: options.missionId, status, ...extra });
  if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(options.missionId))
    throw new ControlStackError("mission_id_invalid", "mission identifier is invalid");
  const url = `/work-items/${encodeURIComponent(options.missionId)}`;
  const detail = requireResponse(await ports.request("GET", url));
  const mission = workItemSchema.parse(
    typeof detail === "object" && detail !== null && "workItem" in detail ? detail.workItem : detail
  );
  if (mission.id !== options.missionId)
    throw new ControlStackError("mission_response_binding_mismatch", "ACS returned another mission");
  let response = await ports.request("GET", `${url}/change-sets`);
  if (response.status === 404) {
    if (!options.plan) return result("awaiting_plan");
    const definition = changeSetDefinitionSchema.parse(await options.plan(mission));
    if (definition.missionId !== mission.id || definition.subjectInputHash !== executionPlanSubjectInputHash(mission))
      throw new ControlStackError("mission_plan_binding_mismatch", "planner proposal does not match mission inputs");
    response = await ports.request("POST", `${url}/change-sets`, {
      definition,
      expectedHeadHash: null,
      submissionId: stableHash({ domain: "acs.mission-runner.proposal.v1", definition })
    });
  }
  const record = changeSetRecordSchema.parse(requireResponse(response));
  if (
    record.manifestHash !== changeSetManifestHash(record.snapshot) ||
    record.snapshot.definition.missionId !== mission.id ||
    record.snapshot.definition.subjectInputHash !== executionPlanSubjectInputHash(mission) ||
    (options.expectedManifestHash !== undefined && options.expectedManifestHash !== record.manifestHash)
  )
    throw new ControlStackError(
      "mission_snapshot_binding_mismatch",
      "mission snapshot changed or failed integrity checks"
    );
  const manifestHash = record.manifestHash;
  const definition = record.snapshot.definition;
  const readProgress = async () => {
    const progress = changeSetProgressSchema.parse(
      requireResponse(await ports.request("GET", `${url}/change-sets/progress?expectedManifestHash=${manifestHash}`))
    );
    if (
      progress.missionId !== mission.id ||
      progress.manifestHash !== manifestHash ||
      progress.operations.length !== definition.operations.length ||
      progress.operations.some(
        (operation, index) => operation.operationId !== definition.operations[index]!.operationId
      )
    )
      throw new ControlStackError("mission_progress_binding_mismatch", "progress belongs to another snapshot");
    return progress;
  };
  const progress = await readProgress();
  if (progress.completion) return result("completed", { manifestHash, completion: progress.completion });
  const failures = progress.operations.some((operation) => ["failed", "blocked"].includes(operation.status));
  const unknown = progress.operations.some((operation) => operation.status === "needs_reconciliation");
  if ((failures || unknown) && definition.constraints.failureBehavior === "stop")
    return result(unknown ? "needs_reconciliation" : "blocked", { manifestHash });
  if (!options.authority) return result("awaiting_approval", { manifestHash });
  const ready = definition.operations.find((operation) => {
    const state = progress.operations.find((entry) => entry.operationId === operation.operationId)!;
    return (
      ["not_permitted", "not_started"].includes(state.status) &&
      operation.dependsOn.every(
        (dependency) => progress.operations.find((entry) => entry.operationId === dependency)?.status === "succeeded"
      )
    );
  });
  if (!ready && progress.operations.some((operation) => operation.status === "awaiting_verification"))
    return result("awaiting_verification", { manifestHash });
  if (!ready && !progress.operations.every((operation) => operation.status === "succeeded"))
    return result(unknown ? "needs_reconciliation" : failures ? "blocked" : "awaiting_results", { manifestHash });
  let reference: { approvalId: string } | { authorizationId: string };
  if ("grantId" in options.authority) {
    const authorized = requireResponse(
      await ports.request("POST", `${url}/change-sets/authorize`, {
        grantId: options.authority.grantId,
        expectedManifestHash: manifestHash
      })
    );
    if (
      typeof authorized !== "object" ||
      authorized === null ||
      !("authorizationId" in authorized) ||
      typeof authorized.authorizationId !== "string"
    )
      throw new ControlStackError("mission_authority_response_invalid", "ACS did not return a snapshot authorization");
    reference = { authorizationId: authorized.authorizationId };
  } else reference = { approvalId: options.authority.approvalId };
  const complete = async (): Promise<MissionRunnerResult> => {
    const completion = changeSetCompletionSchema.parse(
      requireResponse(
        await ports.request("POST", `${url}/change-sets/complete`, { ...reference, expectedManifestHash: manifestHash })
      )
    );
    if (completion.missionId !== mission.id || completion.manifestHash !== manifestHash)
      throw new ControlStackError("mission_completion_binding_mismatch", "completion belongs to another mission");
    return result("completed", { manifestHash, completion });
  };
  if (!ready) return complete();
  const permit = changeSetOperationPermitSchema.parse(
    requireResponse(
      await ports.request("POST", `${url}/change-sets/operations/${encodeURIComponent(ready.operationId)}/permit`, {
        ...reference,
        expectedManifestHash: manifestHash
      })
    )
  );
  if (
    permit.missionId !== mission.id ||
    permit.manifestHash !== manifestHash ||
    permit.operationId !== ready.operationId ||
    permit.runtime !== ready.runtime ||
    permit.toolName !== ready.toolName ||
    permit.executingActorId !== definition.executingActorId
  )
    throw new ControlStackError("mission_permit_binding_mismatch", "permit does not bind the planned operation");
  // Re-read after the idempotent reservation. Another orchestrator may already
  // have claimed/completed it. The gateway performs the final atomic claim.
  const current = await readProgress();
  if (current.operations.find((operation) => operation.operationId === ready.operationId)?.status !== "not_started")
    return result("awaiting_results", { manifestHash, operationId: ready.operationId });
  try {
    await ports.invoke(permit.runtime, ready.toolName, ready.action.params, permit.permitId);
  } catch {
    // A failed transport is not proof the mutation did not run. Preserve the
    // durable attempt and let ACS results/recovery resolve it on a later tick.
    return result("awaiting_results", {
      manifestHash,
      operationId: ready.operationId,
      code: "mission_runtime_outcome_unobserved"
    });
  }
  const after = await readProgress();
  if (after.operations.every((operation) => operation.status === "succeeded")) return complete();
  return result("progressed", { manifestHash, operationId: ready.operationId });
}

/** Bounded polling; every iteration reconstructs state instead of replaying a local plan cursor. */
export async function runMission(
  ports: MissionRunnerPorts,
  options: MissionRunnerOptions & { maxRuntimeMs?: number; pollIntervalMs?: number }
): Promise<MissionRunnerResult> {
  const maxRuntimeMs = options.maxRuntimeMs ?? 30_000;
  const interval = options.pollIntervalMs ?? 100;
  if (
    !Number.isInteger(maxRuntimeMs) ||
    maxRuntimeMs < 1 ||
    maxRuntimeMs > 86_400_000 ||
    !Number.isInteger(interval) ||
    interval < 10 ||
    interval > 60_000
  )
    throw new ControlStackError("mission_runner_budget_invalid", "mission runner polling budget is invalid");
  const deadline = Date.now() + maxRuntimeMs;
  let current: MissionRunnerResult;
  do {
    current = await runMissionOnce(ports, options);
    if (!["progressed", "awaiting_results"].includes(current.status)) return current;
    if (current.code === "mission_runtime_outcome_unobserved") return current;
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(interval, Math.max(0, deadline - Date.now()))));
  } while (Date.now() < deadline);
  return { ...current, code: "mission_runner_time_budget_exhausted" };
}
