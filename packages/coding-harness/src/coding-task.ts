export type CodingTaskState = "inspect" | "plan" | "execute" | "verify" | "blocked" | "complete";

export interface CodingTask {
  id: string;
  goal: string;
  repository: { root: string; worktree?: string; baseCommit: string };
  agent: { provider: string; model: string; role: "planner" | "worker" | "reviewer" };
  constraints: {
    allowedPaths: string[];
    deniedPaths: string[];
    network: "none" | "restricted" | "full";
    allowGitWrite: boolean;
    allowPush: boolean;
    allowServiceRestart: boolean;
  };
  verification: VerificationGate[];
  state: CodingTaskState;
}

export type VerificationGate =
  | { id: string; type: "typecheck" | "tests" | "build" | "git_diff"; required: boolean; command?: string }
  | { id: string; type: "scope"; required: true; allowedPaths: string[]; deniedPaths: string[] };

const states: readonly CodingTaskState[] = ["inspect", "plan", "execute", "verify", "blocked", "complete"];
const transitions: Record<CodingTaskState, readonly CodingTaskState[]> = {
  inspect: ["plan", "blocked"],
  plan: ["execute", "blocked"],
  execute: ["verify", "blocked"],
  verify: ["complete", "blocked", "execute"],
  blocked: ["inspect", "plan", "execute", "verify", "complete"],
  complete: []
};

export function validateCodingTask(task: unknown): CodingTask {
  if (!task || typeof task !== "object") throw new TypeError("coding task must be an object");
  const value = task as CodingTask;
  if (!/^[A-Za-z0-9._:-]{6,128}$/.test(value.id)) throw new TypeError("coding task id is invalid");
  if (typeof value.goal !== "string" || value.goal.trim().length === 0)
    throw new TypeError("coding task goal is required");
  if (!value.repository || typeof value.repository.root !== "string" || value.repository.root.length === 0)
    throw new TypeError("repository root is required");
  if (!/^[a-f0-9]{7,64}$/.test(value.repository.baseCommit)) throw new TypeError("base commit must be a git object id");
  if (!value.agent || typeof value.agent.provider !== "string" || typeof value.agent.model !== "string")
    throw new TypeError("model selection is required");
  if (!["planner", "worker", "reviewer"].includes(value.agent.role)) throw new TypeError("agent role is invalid");
  if (!states.includes(value.state)) throw new TypeError("coding task state is invalid");
  if (!Array.isArray(value.verification) || value.verification.length === 0)
    throw new TypeError("verification gates are required");
  if (!value.constraints || value.constraints.allowPush || value.constraints.allowServiceRestart)
    throw new TypeError("push and service restart are forbidden in the MVP");
  if (value.constraints.network === "full") throw new TypeError("full network access is not permitted in the MVP");
  for (const gate of value.verification) {
    if (typeof gate.id !== "string" || !["typecheck", "tests", "build", "git_diff", "scope"].includes(gate.type))
      throw new TypeError("verification gate is invalid");
  }
  return structuredClone(value);
}

export function transitionCodingTask(task: CodingTask, next: CodingTaskState): CodingTask {
  validateCodingTask(task);
  if (!transitions[task.state].includes(next))
    throw new Error(`invalid coding task transition: ${task.state} -> ${next}`);
  return validateCodingTask({ ...task, state: next });
}

export function createCodingTask(input: Omit<CodingTask, "state">): CodingTask {
  return validateCodingTask({ ...input, state: "inspect" });
}
