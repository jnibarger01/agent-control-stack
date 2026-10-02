export type ShadowComparison = {
  readonly authority: "nimble";
  readonly authoritativeChoice: string | null;
  readonly disagreement: boolean;
  readonly nimbleChoice: string;
  readonly jevChoice: string | null;
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
  return {
    authority: "nimble",
    authoritativeChoice: input.nimbleAccepted ? input.nimbleChoice : null,
    disagreement: input.jevChoice !== null && input.jevChoice !== input.nimbleChoice,
    nimbleChoice: input.nimbleChoice,
    jevChoice: input.jevChoice
  };
}
