import { evaluateGate, type GateResult } from "agentos-contracts";

export function evaluatePromotionGate(evidence: unknown): GateResult {
  return evaluateGate(evidence);
}
