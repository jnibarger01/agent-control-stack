import { ControlStackError, stableHash } from "@agent-control-stack/shared";
import type { CanonicalChangeSetOperation } from "@agent-control-stack/policy-gate";
import type { ChangeSetRecord } from "@agent-control-stack/work-items";

/** Canonical child uses the existing execution-plan/attempt runtime contract. */
export function changeSetExecutionInput(input: {
  record: ChangeSetRecord;
  operationId: string;
  approvalId?: string;
  authorizationId?: string;
  facts: CanonicalChangeSetOperation;
  runtimeId: string;
  identityConfigFingerprint?: string;
}) {
  const definition = input.record.snapshot.definition;
  const operation = definition.operations.find((op) => op.operationId === input.operationId);
  if (!operation || operation.runtime === "sandbox")
    throw new ControlStackError("change_set_runtime_unsupported", "operation has no governed runtime adapter");
  const jc = operation.runtime === "jace_commander";
  const bindingHash = stableHash({
    ...(jc ? { contract: "acs.jc.v1" } : {}),
    tool: operation.toolName,
    invocationHash: input.facts.invocationHash,
    runtimeId: input.runtimeId,
    ...(!jc ? { identityConfigFingerprint: input.identityConfigFingerprint } : {}),
    requiredScopes: input.facts.privileges,
    requesterSubject: definition.executingActorId
  });
  const context = input.facts.context;
  return {
    title: `Change Set operation: ${operation.operationId}`,
    intent: `Governed operation ${operation.operationId} for mission ${definition.missionId}`,
    requester: "agent" as const,
    requesterSubject: definition.executingActorId,
    target: { ...(context.cwd ? { cwd: context.cwd } : {}), files: context.paths ?? [] },
    risk: context.risk,
    requestedActions: [
      {
        kind: context.action.kind,
        description: context.action.description,
        params: {
          tool: operation.toolName,
          invocationHash: input.facts.invocationHash,
          bindingHash,
          runtimeId: input.runtimeId,
          ...(jc ? { contract: "acs.jc.v1" } : { identityConfigFingerprint: input.identityConfigFingerprint }),
          requiredScopes: input.facts.privileges,
          requesterSubject: definition.executingActorId,
          write: context.write ?? false,
          network: context.network ?? false,
          destructive: context.destructive ?? false,
          ...(context.cwd ? { cwd: context.cwd } : {}),
          paths: context.paths ?? [],
          ...(context.command ? { command: context.command } : {}),
          changeSetBinding: {
            missionId: definition.missionId,
            manifestHash: input.record.manifestHash,
            operationId: operation.operationId,
            ...(input.approvalId ? { approvalId: input.approvalId } : { authorizationId: input.authorizationId })
          }
        }
      }
    ]
  };
}
