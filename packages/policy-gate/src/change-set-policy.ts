import { ControlStackError, stableHash, strictCanonicalJsonV1 } from "@agent-control-stack/shared";
import {
  changeSetRecordSchema,
  changeSetManifestHash,
  executionPlanSubjectInputHash,
  type ChangeSetRecord,
  type ChangeSetDefinition,
  type WorkItem
} from "@agent-control-stack/work-items";
import {
  evaluatePolicy,
  policyContextSchema,
  summarizePolicy,
  type PolicyContext,
  type PolicyEvaluation
} from "./policy.js";
import { actionFingerprint } from "./fingerprint.js";

type Operation = ChangeSetDefinition["operations"][number];
export interface CanonicalChangeSetOperation {
  invocationHash: string;
  resources: Operation["resources"];
  privileges: Operation["requestedPrivileges"];
  effect: Operation["effect"];
  context: PolicyContext;
}

/** Resolver is trusted application code using runtime contracts, never a request/model field. */
export function evaluateChangeSetPolicy(input: {
  record: ChangeSetRecord;
  mission: WorkItem;
  actorId: string;
  expectedManifestHash: string;
  resolveOperation: (operation: Operation) => CanonicalChangeSetOperation;
  now?: Date;
}) {
  const record = changeSetRecordSchema.parse(input.record);
  const definition = record.snapshot.definition;
  if (record.manifestHash !== changeSetManifestHash(record.snapshot))
    throw new ControlStackError("change_set_integrity_mismatch", "change set hash mismatch");
  if (record.manifestHash !== input.expectedManifestHash)
    throw new ControlStackError("change_set_revision_conflict", "change set head changed");
  if (
    definition.missionId !== input.mission.id ||
    definition.subjectInputHash !== executionPlanSubjectInputHash(input.mission)
  )
    throw new ControlStackError("change_set_input_mismatch", "mission inputs changed");
  if (Date.parse(definition.expiresAt) <= (input.now ?? new Date()).getTime())
    throw new ControlStackError("change_set_expired", "change set expired");
  if (["succeeded", "failed", "cancelled", "rejected", "quarantined"].includes(input.mission.status))
    throw new ControlStackError("change_set_mission_terminal", "mission is terminal");
  const effects = { read_only: 0, mutation: 1, privileged: 2 };
  const evaluations: PolicyEvaluation[] = [];
  const operations = definition.operations.map((operation) => {
    const facts = input.resolveOperation(operation);
    strictCanonicalJsonV1(facts.resources);
    const context = policyContextSchema.parse(facts.context);
    if (
      context.workItemId !== input.mission.id ||
      context.actor !== input.actorId ||
      context.operation !== "create" ||
      context.requester !== input.mission.requester ||
      context.requesterSubject !== input.mission.requesterSubject ||
      !/^[a-f0-9]{64}$/u.test(facts.invocationHash)
    )
      throw new ControlStackError("change_set_policy_binding_invalid", "canonical policy binding mismatch");
    const declarations = new Set(operation.resources.map(strictCanonicalJsonV1));
    const mismatch =
      effects[operation.effect] < effects[facts.effect] ||
      facts.privileges.some((privilege) => !operation.requestedPrivileges.includes(privilege)) ||
      facts.resources.some((resource) => !declarations.has(strictCanonicalJsonV1(resource)));
    const decision = mismatch
      ? {
          decision: "deny" as const,
          reason: "proposal understates canonical operation scope, privileges or effects",
          matchedRules: ["deny:change-set-declaration-mismatch"]
        }
      : evaluatePolicy(context);
    evaluations.push({ context, action: context.action, actionHash: actionFingerprint(context), decision });
    return {
      operationId: operation.operationId,
      invocationHash: facts.invocationHash,
      factsHash: stableHash({
        domain: "acs.change-set.operation-policy.v1",
        manifestHash: record.manifestHash,
        operationId: operation.operationId,
        facts
      }),
      decision
    };
  });
  return {
    schemaVersion: "acs.change-set.policy.v1",
    missionId: input.mission.id,
    revision: record.snapshot.revision,
    manifestHash: record.manifestHash,
    actorId: input.actorId,
    operations,
    decision: summarizePolicy(evaluations)
  };
}
