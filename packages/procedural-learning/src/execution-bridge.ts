import type { ProceduralLearning, RetrieveQuery, RetrievedSkill } from "./learning.js";
import type { RefinementOutcome } from "./schema.js";

export interface ProblemSignature extends RetrieveQuery {
  problemSummary: string;
}

export interface InjectedSkill {
  skillId: string;
  version: number;
  confidence: number;
  guidance: string[];
}

export interface ExecutionLearningRecord {
  retrievedSkills: InjectedSkill[];
  usedSkills: string[];
  refinements: Array<{ skillId: string; refinement: RefinementOutcome; recorded: boolean }>;
}

const TECH_HINTS = ["vite", "react", "pnpm", "npm", "systemd", "postgres", "mcp", "hermes"] as const;

export function deriveProblemSignature(workItem: {
  title: string;
  intent: string;
  target?: { repo?: string; cwd?: string };
  requestedActions?: Array<{ kind: string; description: string; params?: Record<string, unknown> }>;
}): ProblemSignature {
  const actionText = (workItem.requestedActions ?? [])
    .map((action) => `${action.kind} ${action.description} ${JSON.stringify(action.params ?? {})}`)
    .join(" ");
  const blob = `${workItem.title}\n${workItem.intent}\n${actionText}`;
  const technologies = TECH_HINTS.filter((hint) => blob.toLowerCase().includes(hint));
  const errorMessages = blob
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /error|invalid hook|failed|exception|timeout/i.test(line));
  let taskType = "engineering";
  if (/hook|vite|build/i.test(blob)) taskType = "build-recovery";
  else if (/systemd|service/i.test(blob)) taskType = "service-debugging";
  else if (/conflict|pull request|merge/i.test(blob)) taskType = "pr-conflict";
  return {
    problemSummary: `${workItem.title}. ${workItem.intent}`.trim(),
    errorMessages: errorMessages.length > 0 ? errorMessages : [workItem.intent],
    technologies: technologies.length > 0 ? [...technologies] : ["unknown"],
    taskType,
    repository: workItem.target?.repo ?? workItem.target?.cwd
  };
}

export function toInjectedSkills(skills: RetrievedSkill[]): InjectedSkill[] {
  return skills.map((skill) => ({
    skillId: skill.name,
    version: skill.version,
    confidence: skill.confidence,
    guidance: [
      ...skill.content.diagnostic_sequence,
      ...skill.content.repair_sequence,
      ...skill.content.validation
    ]
  }));
}

export class ExecutionLearningBridge {
  constructor(private readonly learning: ProceduralLearning) {}

  beforeExecution(
    workItem: {
      id: string;
      title: string;
      intent: string;
      target?: { repo?: string; cwd?: string };
      requestedActions?: Array<{ kind: string; description: string; params?: Record<string, unknown> }>;
    },
    attemptId: string
  ): { signature: ProblemSignature; retrievedSkills: InjectedSkill[] } {
    const signature = deriveProblemSignature(workItem);
    const retrieved = this.learning.retrieveSkills(signature);
    for (const skill of retrieved) {
      this.learning.recordSkillUsage({
        skillName: skill.name,
        taskId: workItem.id,
        attemptId,
        disposition: "retrieved",
        repository: signature.repository
      });
    }
    return { signature, retrievedSkills: toInjectedSkills(retrieved) };
  }

  afterExecution(input: {
    workItemId: string;
    attemptId: string;
    repository?: string;
    retrievedSkills: InjectedSkill[];
    usedSkillIds: string[];
    engineSucceeded: boolean;
    validationPassed?: boolean;
  }): ExecutionLearningRecord {
    const used = new Set(input.usedSkillIds);
    const refinements = input.retrievedSkills.map((skill) => {
      const outcome = this.learning.evaluateSkillOutcome({
        skillName: skill.skillId,
        taskId: input.workItemId,
        attemptId: input.attemptId,
        used: used.has(skill.skillId),
        engineSucceeded: input.engineSucceeded,
        validationPassed: input.validationPassed,
        repository: input.repository
      });
      return { skillId: skill.skillId, ...outcome };
    });
    return {
      retrievedSkills: input.retrievedSkills,
      usedSkills: [...used],
      refinements
    };
  }
}
