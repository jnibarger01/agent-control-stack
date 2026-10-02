export type DecisionLevel = 0 | 1 | 2;

/**
 * Level 0 is an objective fact in code.
 * Level 1 is a typed semantic selection.
 * Level 2 is generation. It is used only when the caller says generation is required
 * and no objective fact already answers the question.
 */
export function selectDecisionLevel(input: {
  readonly objectiveFactAvailable: boolean;
  readonly generationRequired?: boolean;
}): DecisionLevel {
  if (input.objectiveFactAvailable) return 0;
  if (input.generationRequired === true) return 2;
  return 1;
}
