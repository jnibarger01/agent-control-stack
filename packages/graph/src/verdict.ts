import type { GraphDefinition, GraphNodeState, GraphVerdict } from "./contract.js";

export interface VerdictNodeView {
  nodeId: string;
  state: GraphNodeState;
  required: boolean;
}

export interface GraphVerdictAssessment {
  verdict: GraphVerdict;
  requiredCoverage: number;
  failedRequiredNodeIds: string[];
  blockedRequiredNodeIds: string[];
  incompleteRequiredNodeIds: string[];
  failedOptionalNodeIds: string[];
  failedAcceptanceTestIds: string[];
}

export function calculateGraphVerdict(
  definition: GraphDefinition,
  nodes: readonly VerdictNodeView[]
): GraphVerdictAssessment {
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const required = definition.nodes.filter((node) => node.required);
  const succeededRequired = required.filter((node) => byId.get(node.id)?.state === "SUCCEEDED");
  const failedRequiredNodeIds = required.filter((node) => byId.get(node.id)?.state === "FAILED").map((node) => node.id);
  const blockedRequiredNodeIds = required
    .filter((node) => byId.get(node.id)?.state === "BLOCKED")
    .map((node) => node.id);
  const incompleteRequiredNodeIds = required
    .filter((node) => byId.get(node.id)?.state !== "SUCCEEDED")
    .filter((node) => !failedRequiredNodeIds.includes(node.id) && !blockedRequiredNodeIds.includes(node.id))
    .map((node) => node.id);
  const failedOptionalNodeIds = definition.nodes
    .filter((node) => !node.required)
    .filter((node) => {
      const state = byId.get(node.id)?.state;
      return state === "FAILED" || state === "BLOCKED" || state === "CANCELLED" || state === "SKIPPED";
    })
    .map((node) => node.id);
  const failedAcceptanceTestIds = definition.acceptanceTests
    .filter((test) => test.required)
    .filter((test) => test.nodeIds.some((nodeId) => byId.get(nodeId)?.state !== "SUCCEEDED"))
    .map((test) => test.id);
  const requiredCoverage = required.length === 0 ? 0 : succeededRequired.length / required.length;

  let verdict: GraphVerdict = "PASS";
  if (blockedRequiredNodeIds.length > 0) {
    verdict = "BLOCK";
  } else if (failedRequiredNodeIds.length > 0) {
    verdict = definition.verdictPolicy.requiredFailure;
  } else if (
    incompleteRequiredNodeIds.length > 0 ||
    requiredCoverage < definition.verdictPolicy.requiredCoverage ||
    failedAcceptanceTestIds.length > 0
  ) {
    verdict = "PARTIAL";
  } else if (failedOptionalNodeIds.length > 0 && definition.verdictPolicy.optionalFailure === "PARTIAL") {
    verdict = "PARTIAL";
  }

  return {
    verdict,
    requiredCoverage,
    failedRequiredNodeIds,
    blockedRequiredNodeIds,
    incompleteRequiredNodeIds,
    failedOptionalNodeIds,
    failedAcceptanceTestIds
  };
}
