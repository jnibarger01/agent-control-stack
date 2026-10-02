import { resolve } from "node:path";
import { createCodingTask } from "./coding-task.js";
import { OllamaCodingModel } from "./coding-model.js";
import {
  CodingHarness,
  HarnessVerificationRunner,
  JsonlAuditSink,
  JsonlTaskStateStore,
  type AcsToolGateway,
  type VerificationRunner
} from "./coding-runtime.js";
import { createManagedCodingExecution } from "./managed-execution.js";

export interface CodingCliOptions {
  repo: string;
  model: string;
  goal: string;
  maxIterations: number;
  baseCommit: string;
  taskId?: string;
  statePath: string;
  auditPath: string;
}
export function parseCodingCliArgs(args: string[]): CodingCliOptions {
  let repo = "";
  let model = "ollama:qwen2.5-coder";
  let maxIterations = 24;
  let baseCommit = "";
  let taskId: string | undefined;
  let statePath = "storage/coding-harness/tasks.jsonl";
  let auditPath = "storage/coding-harness/audit.jsonl";
  const goal: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = args[index + 1];
    if (arg === "--repo" && value) {
      repo = value;
      index += 1;
    } else if (arg === "--model" && value) {
      model = value;
      index += 1;
    } else if (arg === "--base-commit" && value) {
      baseCommit = value;
      index += 1;
    } else if (arg === "--max-iterations" && value && Number.isInteger(Number(value)) && Number(value) > 0) {
      maxIterations = Number(value);
      index += 1;
    } else if (arg === "--task-id" && value) {
      taskId = value;
      index += 1;
    } else if (arg === "--state" && value) {
      statePath = value;
      index += 1;
    } else if (arg === "--audit" && value) {
      auditPath = value;
      index += 1;
    } else if (arg.startsWith("--")) throw new Error(`unknown coding option: ${arg}`);
    else goal.push(arg);
  }
  if (!repo || !baseCommit || !goal.join(" ").trim())
    throw new Error("Usage: acs code --repo <path> --base-commit <sha> [--model provider:model] <prompt>");
  const provider = model.split(":", 1)[0] ?? "ollama";
  if (provider !== "ollama") throw new Error(`unsupported model provider: ${provider}`);
  return {
    repo: resolve(repo),
    model: model.slice(provider.length + 1),
    baseCommit,
    goal: goal.join(" "),
    maxIterations,
    ...(taskId ? { taskId } : {}),
    statePath,
    auditPath
  };
}

export interface CodingCliDeps {
  gateway: AcsToolGateway;
  verification: VerificationRunner;
}
export async function runCodingCli(
  options: CodingCliOptions,
  deps: CodingCliDeps,
  io: { write(chunk: string): void } = process.stdout
): Promise<number> {
  const taskId = options.taskId ?? `coding-${Date.now().toString(36)}`;
  const store = new JsonlTaskStateStore(options.statePath);
  const task =
    (await store.load(taskId)) ??
    createCodingTask({
      id: taskId,
      goal: options.goal,
      repository: { root: options.repo, baseCommit: options.baseCommit },
      agent: { provider: "ollama", model: options.model, role: "worker" },
      constraints: {
        allowedPaths: ["."],
        deniedPaths: [".git"],
        network: "none",
        allowGitWrite: true,
        allowPush: false,
        allowServiceRestart: false
      },
      verification: [{ id: "scope", type: "scope", required: true, allowedPaths: ["."], deniedPaths: [".git"] }]
    });
  const harness = new CodingHarness({
    model: new OllamaCodingModel(options.model),
    gateway: deps.gateway,
    store,
    audit: new JsonlAuditSink(options.auditPath),
    verification: deps.verification,
    workspace: options.repo
  });
  const result = await harness.run(task, options.goal, {
    maxIterations: options.maxIterations,
    onEvent: (event) => io.write(`${JSON.stringify(event)}\n`)
  });
  io.write(`${result.verdict.verdict}: ${result.verdict.reason}\n`);
  return result.verdict.verdict === "PASS" ? 0 : result.verdict.verdict === "BLOCK" ? 2 : 1;
}

export interface ManagedCodingCliOptions extends CodingCliOptions {
  dbPath: string;
  approver: string;
  workerId?: string;
  /** Requesting identity for the harness's governed work items; must differ from the approver. */
  requesterSubject?: string;
  worktreeRoot?: string;
  cleanup?: boolean;
}

export async function runManagedCodingCli(
  options: ManagedCodingCliOptions,
  io: { write(chunk: string): void } = process.stdout
): Promise<number> {
  const taskId = options.taskId ?? `coding-${Date.now().toString(36)}`;
  const task = createCodingTask({
    id: taskId,
    goal: options.goal,
    repository: { root: options.repo, baseCommit: options.baseCommit },
    agent: { provider: "ollama", model: options.model, role: "worker" },
    constraints: {
      allowedPaths: ["."],
      deniedPaths: [".git"],
      network: "none",
      allowGitWrite: true,
      allowPush: false,
      allowServiceRestart: false
    },
    verification: [{ id: "scope", type: "scope", required: true, allowedPaths: ["."], deniedPaths: [".git"] }]
  });
  const managed = await createManagedCodingExecution({
    dbPath: options.dbPath,
    repoRoot: options.repo,
    task,
    ...(options.workerId ? { workerId: options.workerId } : {}),
    approver: options.approver,
    ...(options.requesterSubject ? { requesterSubject: options.requesterSubject } : {}),
    ...(options.worktreeRoot ? { worktreeRoot: options.worktreeRoot } : {})
  });
  const store = new JsonlTaskStateStore(options.statePath);
  const resumed = await store.load(taskId);
  const effectiveTask = resumed ?? task;
  try {
    const harness = new CodingHarness({
      model: new OllamaCodingModel(options.model),
      gateway: managed.gateway,
      store,
      audit: new JsonlAuditSink(options.auditPath),
      verification: new HarnessVerificationRunner(managed.gateway),
      workspace: managed.workspace
    });
    const result = await harness.run(effectiveTask, options.goal, {
      maxIterations: options.maxIterations,
      onEvent: (event) => io.write(`${JSON.stringify(event)}\n`)
    });
    io.write(`${result.verdict.verdict}: ${result.verdict.reason}\n`);
    return result.verdict.verdict === "PASS" ? 0 : result.verdict.verdict === "BLOCK" ? 2 : 1;
  } finally {
    if (options.cleanup !== false) await managed.dispose();
  }
}
