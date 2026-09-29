export type JevValue = string | number | boolean | null | { readonly [key: string]: JevValue } | readonly JevValue[];

export type NoulQuestion = {
  readonly type: "noul";
  readonly instructions: JevValue;
  readonly criteria?: { readonly true: JevValue; readonly false: JevValue };
};

export type ChoiceQuestion = {
  readonly type: "choice";
  readonly instructions: JevValue;
  readonly criteria: Readonly<Record<string, JevValue>>;
};

export type ScoreQuestion = {
  readonly type: "score";
  readonly instructions: JevValue;
  readonly criteria: readonly JevValue[];
};

export type JevQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;
export type JevQuestions = Readonly<Record<string, JevQuestion>>;
export type NoulAnswer = {
  readonly type: "noul";
  /** TypeSafe Noul probability: P(yes). */
  readonly noul: number;
};

export type ChoiceAnswer = {
  readonly type: "choice";
  readonly choice: string;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly confidence: number;
};

export type ScoreAnswer = {
  readonly type: "score";
  readonly score: number;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly confidence: number;
  readonly legend?: Readonly<Record<string, string>>;
};

export type JevAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export function noul(instructions: JevValue, criteria?: NoulQuestion["criteria"]): NoulQuestion {
  return criteria === undefined ? { type: "noul", instructions } : { type: "noul", instructions, criteria };
}
export function choice(instructions: JevValue, criteria: Readonly<Record<string, JevValue>>): ChoiceQuestion {
  return { type: "choice", instructions, criteria };
}

export function score(instructions: JevValue, criteria: readonly JevValue[]): ScoreQuestion {
  return { type: "score", instructions, criteria };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function parseProbabilities(value: unknown, expectedKeys: readonly string[]): Readonly<Record<string, number>> | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== expectedKeys.length) return null;
  const expected = new Set(expectedKeys);
  const parsed: Record<string, number> = {};
  let sum = 0;
  for (const [key, probability] of Object.entries(value)) {
    if (!expected.has(key) || !isProbability(probability)) return null;
    parsed[key] = probability;
    sum += probability;
  }
  if (Math.abs(sum - 1) > 0.02) return null;
  return parsed;
}

export function asNoulAnswer(value: unknown): NoulAnswer | null {
  if (!isRecord(value) || value.type !== "noul" || !isProbability(value.noul)) return null;
  return { type: "noul", noul: value.noul };
}

export function asChoiceAnswer(value: unknown, question: ChoiceQuestion): ChoiceAnswer | null {
  if (!isRecord(value) || value.type !== "choice") return null;
  if (typeof value.choice !== "string" || !(value.choice in question.criteria)) return null;
  if (!isProbability(value.confidence)) return null;
  const probabilities = parseProbabilities(value.probabilities, Object.keys(question.criteria));
  if (!probabilities) return null;
  return { type: "choice", choice: value.choice, probabilities, confidence: value.confidence };
}
export function asScoreAnswer(value: unknown, question: ScoreQuestion): ScoreAnswer | null {
  if (!isRecord(value) || value.type !== "score") return null;
  if (
    typeof value.score !== "number" ||
    !Number.isFinite(value.score) ||
    value.score < 0 ||
    value.score > question.criteria.length - 1 ||
    !isProbability(value.confidence)
  ) {
    return null;
  }
  const expected = question.criteria.map((_, index) => String(index));
  const probabilities = parseProbabilities(value.probabilities, expected);
  if (!probabilities) return null;
  let legend: Record<string, string> | undefined;
  if (isRecord(value.legend)) {
    legend = {};
    for (const [key, entry] of Object.entries(value.legend)) {
      if (expected.includes(key) && typeof entry === "string" && entry.length <= 512) {
        legend[key] = entry;
      }
    }
  }
  return legend === undefined
    ? { type: "score", score: value.score, probabilities, confidence: value.confidence }
    : { type: "score", score: value.score, probabilities, confidence: value.confidence, legend };
}

export function parseJevAnswer(question: JevQuestion, value: unknown): JevAnswer | null {
  if (question.type === "noul") return asNoulAnswer(value);
  if (question.type === "choice") return asChoiceAnswer(value, question);
  if (question.type === "score") return asScoreAnswer(value, question);
  return null;
}
