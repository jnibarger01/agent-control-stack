import { noul, type JevQuestions, type NoulQuestion } from "./contracts/questions.js";

export const JEV_INTAKE_QUESTION_SET_VERSION = "jev-intake@2" as const;

export type JevQuestionCategory = "routing" | "risk";
export type JevQuestionRegistryEntry = {
  readonly id: string;
  readonly primitive: "noul";
  readonly instructions: string;
  readonly questionSetVersion: typeof JEV_INTAKE_QUESTION_SET_VERSION;
  readonly consumer: "mission-intake";
  readonly category: JevQuestionCategory;
  readonly question: NoulQuestion;
};

function intakeNoul(id: string, instructions: string, category: JevQuestionCategory): JevQuestionRegistryEntry {
  return {
    id,
    primitive: "noul",
    instructions,
    questionSetVersion: JEV_INTAKE_QUESTION_SET_VERSION,
    consumer: "mission-intake",
    category,
    question: noul(instructions)
  };
}
export const JEV_INTAKE_QUESTION_REGISTRY = {
  actionable: intakeNoul("actionable", "Does this request require an action rather than only conversation?", "routing"),
  needs_code: intakeNoul("needs_code", "Does fulfilling this request require writing or modifying code?", "routing"),
  needs_shell: intakeNoul("needs_shell", "Does fulfilling this request require running shell commands?", "routing"),
  needs_browser: intakeNoul(
    "needs_browser",
    "Does fulfilling this request require browser or web interaction?",
    "routing"
  ),
  needs_mobile: intakeNoul("needs_mobile", "Does fulfilling this request require a mobile device?", "routing"),
  needs_desktop: intakeNoul(
    "needs_desktop",
    "Does fulfilling this request require desktop or GUI automation?",
    "routing"
  ),
  destructive: intakeNoul("destructive", "Would fulfilling this request be destructive or irreversible?", "risk"),
  auth_sensitive: intakeNoul(
    "auth_sensitive",
    "Does this request involve credentials, secrets, or authentication material?",
    "risk"
  ),
  runtime_mutation: intakeNoul(
    "runtime_mutation",
    "Would fulfilling this request mutate runtime or system state?",
    "risk"
  ),
  approval_likely: intakeNoul("approval_likely", "Is human approval likely required for this request?", "risk")
} as const satisfies Readonly<Record<string, JevQuestionRegistryEntry>>;

export type JevIntakeQuestionId = keyof typeof JEV_INTAKE_QUESTION_REGISTRY;
export const JEV_INTAKE_QUESTIONS: JevQuestions = Object.fromEntries(
  Object.entries(JEV_INTAKE_QUESTION_REGISTRY).map(([id, entry]) => [id, entry.question])
);

export const JEV_ROUTING_SIGNALS = Object.freeze(
  Object.entries(JEV_INTAKE_QUESTION_REGISTRY)
    .filter(([, entry]) => entry.category === "routing")
    .map(([id]) => id as JevIntakeQuestionId)
);

export const JEV_RISK_SIGNALS = Object.freeze(
  Object.entries(JEV_INTAKE_QUESTION_REGISTRY)
    .filter(([, entry]) => entry.category === "risk")
    .map(([id]) => id as JevIntakeQuestionId)
);
