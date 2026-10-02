import type { DecisionReceipt } from "./receipts.js";

export type ShadowComparison = {
  readonly authority: "nimble";
  readonly authoritativeModel: "nimble";
  readonly shadowModel: "jev";
  readonly authoritativeChoice: string | null;
  readonly disagreement: boolean;
  readonly shadowDisagreement: boolean;
  readonly nimbleChoice: string;
  readonly jevChoice: string | null;
  readonly shadowAnswered: boolean;
};

/**
 * Jev is a shadow evaluator. A missing Jev answer is not fabricated.
 * When Nimble was not accepted, Jev does not become the choice.
 */
export function compareShadow(input: {
  readonly nimbleChoice: string;
  readonly nimbleAccepted: boolean;
  readonly jevChoice: string | null;
}): ShadowComparison {
  const disagreement = input.jevChoice !== null && input.jevChoice !== input.nimbleChoice;
  return {
    authority: "nimble",
    authoritativeModel: "nimble",
    shadowModel: "jev",
    authoritativeChoice: input.nimbleAccepted ? input.nimbleChoice : null,
    disagreement,
    shadowDisagreement: disagreement,
    nimbleChoice: input.nimbleChoice,
    jevChoice: input.jevChoice,
    shadowAnswered: input.jevChoice !== null
  };
}

/** Records the shadow beside the Nimble selection. It does not change selectedId. */
export function applyShadow(receipt: DecisionReceipt, comparison: ShadowComparison): DecisionReceipt {
  return {
    ...receipt,
    authoritativeModel: "nimble",
    shadowModel: "jev",
    shadowDisagreement: comparison.shadowDisagreement,
    shadowAnswered: comparison.shadowAnswered,
    selectedId: receipt.selectedId
  };
}
