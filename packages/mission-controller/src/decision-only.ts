import {
  nextMissionAction,
  type DecisionReceipt,
  type MissionPolicyFacts,
  type MissionStep,
  type NimbleDecisionModel
} from "@agent-control-stack/decision-engine";

export type IssuedPermit = {
  readonly permitId: string;
  readonly operationId: string;
  readonly issuer: "execution-admission" | "policy-gate";
};

export type IssuedPermitReader = {
  readIssuedPermit(permitId: string): IssuedPermit | null;
};

export type DecisionReceiptLog = {
  append(receipt: DecisionReceipt): void;
};

export type DecisionOnlyResult = {
  readonly step: MissionStep;
  /** This mode never executes. A permit handoff is still not an execution. */
  readonly executable: false;
  readonly permit: IssuedPermit | null;
  readonly blockReason: "not_ready" | "permit_not_issued" | "permit_operation_mismatch" | null;
};

function receiptOf(step: MissionStep): DecisionReceipt | null {
  return "receipt" in step ? step.receipt : null;
}

/**
 * Decision-only mission step.
 * The selected operation is offered to an already-issued permit reader.
 * This function does not acquire a permit, restore one, or call a tool.
 */
export async function runDecisionOnlyStep(input: {
  readonly state: unknown;
  readonly model: NimbleDecisionModel;
  readonly policy: MissionPolicyFacts;
  readonly createdAt: string;
  readonly shadow?: { readonly jevChoice: string | null };
  readonly receipts: DecisionReceiptLog;
  readonly permits: IssuedPermitReader;
}): Promise<DecisionOnlyResult> {
  const step = await nextMissionAction({
    state: input.state,
    model: input.model,
    policy: input.policy,
    createdAt: input.createdAt,
    shadow: input.shadow
  });
  const receipt = receiptOf(step);
  if (receipt) input.receipts.append(receipt);
  if (step.status !== "ready") {
    return { step, executable: false, permit: null, blockReason: "not_ready" };
  }
  const issued = input.permits.readIssuedPermit(step.authorization.permitId);
  if (issued === null) {
    return { step, executable: false, permit: null, blockReason: "permit_not_issued" };
  }
  if (issued.operationId !== step.decision.selectedOperationId) {
    return { step, executable: false, permit: null, blockReason: "permit_operation_mismatch" };
  }
  return { step, executable: false, permit: issued, blockReason: null };
}

/**
 * Restart and reconciliation read a stored receipt. The receipt cannot
 * become authorization. A handoff exists only when the caller still holds
 * an issued permit for that same operation.
 */
export function reconcileStoredDecision(input: {
  readonly receipt: DecisionReceipt;
  readonly permit: IssuedPermit | null;
}): { readonly executable: false; readonly handoff: IssuedPermit | null; readonly reason: string } {
  if (
    input.permit === null ||
    input.receipt.fallbackUsed ||
    input.receipt.selectedId === null ||
    input.receipt.authoritativeModel !== "nimble"
  ) {
    return { executable: false, handoff: null, reason: "receipt_is_not_authorization" };
  }
  if (input.permit.operationId !== input.receipt.selectedId) {
    return { executable: false, handoff: null, reason: "permit_operation_mismatch" };
  }
  return { executable: false, handoff: input.permit, reason: "issued_permit_still_required" };
}
