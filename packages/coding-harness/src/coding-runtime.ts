import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { validateCodingTask, type CodingTask } from "./coding-task.js";
import type { AgentTurn, CodingModel } from "./coding-model.js";
import { executeCodingTool, normalizeCodingTool, type AcsToolGateway, type ToolObservation } from "./coding-tools.js";
export type { AcsToolGateway, ToolObservation } from "./coding-tools.js";

export interface AuditSink {
  append(event: Record<string, unknown>): Promise<void>;
}
export class JsonlAuditSink implements AuditSink {
  constructor(private readonly path: string) {}
  async append(event: Record<string, unknown>): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(event)}\n`, "utf8");
  }
}
export interface TaskStateStore {
  load(id: string): Promise<CodingTask | undefined>;
  save(task: CodingTask, event: Record<string, unknown>): Promise<void>;
}
export class JsonlTaskStateStore implements TaskStateStore {
  constructor(private readonly path: string) {}
  async load(id: string): Promise<CodingTask | undefined> {
    try {
      const lines = (await readFile(this.path, "utf8")).trim().split("\n").filter(Boolean);
      for (const line of lines.reverse()) {
        const value = JSON.parse(line) as { task?: CodingTask };
        if (value.task?.id === id) return validateCodingTask(value.task);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error(`coding task state is malformed: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error
      });
    }
    return undefined;
  }
  async save(task: CodingTask, event: Record<string, unknown>): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify({ task, event })}\n`, "utf8");
  }
}
export interface Verdict {
  verdict: "PASS" | "PARTIAL" | "BLOCK" | "FAIL";
  evidence: readonly string[];
  reason: string;
}
export interface VerificationRunner {
  run(task: CodingTask, signal: AbortSignal): Promise<Verdict>;
}
export class HarnessVerificationRunner implements VerificationRunner {
  constructor(private readonly gateway: AcsToolGateway) {}
  async run(task: CodingTask, signal: AbortSignal): Promise<Verdict> {
    const evidence: string[] = [];
    for (const gate of task.verification) {
      try {
        const command =
          gate.type === "tests"
            ? "npm test -- --runInBand"
            : gate.type === "build"
              ? "npm run build"
              : gate.type === "typecheck"
                ? "npm run typecheck"
                : gate.type === "git_diff"
                  ? "git diff --check"
                  : undefined;
        if (command) {
          const result = await executeCodingTool(
            this.gateway,
            {
              tool: "verification.run",
              dcTool: "start_process",
              args: { command, cwd: task.repository.worktree ?? task.repository.root, timeout_ms: 300_000 },
              workspace: task.repository.worktree ?? task.repository.root
            },
            signal
          );
          evidence.push(`${gate.id}:${result.ok ? "ok" : "failed"}:${result.evidenceHash}`);
          if (!result.ok) return { verdict: gate.required ? "FAIL" : "PARTIAL", evidence, reason: `${gate.id} failed` };
        } else if (gate.type === "scope") {
          evidence.push(`${gate.id}:ok`);
        }
      } catch (error) {
        return { verdict: "BLOCK", evidence, reason: error instanceof Error ? error.message : String(error) };
      }
    }
    return { verdict: "PASS", evidence, reason: "all required verification gates passed" };
  }
}
export interface CodingLoopOptions {
  maxIterations?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  now?: () => number;
  onEvent?: (event: Record<string, unknown>) => void;
}
export interface CodingLoopResult {
  task: CodingTask;
  turn: AgentTurn;
  verdict: Verdict;
  iterations: number;
  observations: ToolObservation[];
}
export class CodingHarness {
  constructor(
    private readonly deps: {
      model: CodingModel;
      gateway: AcsToolGateway;
      store: TaskStateStore;
      audit: AuditSink;
      verification: VerificationRunner;
      workspace: string;
    }
  ) {}
  async run(task: CodingTask, goal: string, options: CodingLoopOptions = {}): Promise<CodingLoopResult> {
    const maxIterations = options.maxIterations ?? 24;
    const timeoutMs = options.timeoutMs ?? 15 * 60_000;
    const start = (options.now ?? Date.now)();
    const observations: ToolObservation[] = [];
    let turn: AgentTurn | undefined;
    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      if ((options.now ?? Date.now)() - start > timeoutMs || options.signal?.aborted)
        return this.finish(
          task,
          { verdict: "BLOCK", evidence: [], reason: "coding harness timeout or cancellation" },
          observations,
          iteration
        );
      await this.deps.store.save(task, { type: "agent_turn_start", iteration });
      turn = await this.deps.model.generate({ taskId: task.id, goal, state: task.state, observations, iteration });
      for (const call of turn.toolCalls) {
        if (call.name === "verification.run") {
          return this.finish(
            task,
            {
              verdict: "BLOCK",
              evidence: observations.map((item) => item.evidenceHash),
              reason: "verification is harness-owned"
            },
            observations,
            iteration + 1
          );
        }
        let request: ReturnType<typeof normalizeCodingTool>;
        try {
          request = normalizeCodingTool(call.name, call.arguments, this.deps.workspace);
        } catch (error) {
          return this.finish(
            task,
            {
              verdict: "BLOCK",
              evidence: observations.map((item) => item.evidenceHash),
              reason: error instanceof Error ? error.message : String(error)
            },
            observations,
            iteration + 1
          );
        }
        const result = await executeCodingTool(this.deps.gateway, request, options.signal);
        observations.push(result);
        await this.deps.audit.append({
          taskId: task.id,
          iteration,
          tool: request.tool,
          dcTool: request.dcTool,
          argsDigest: createHash("sha256").update(JSON.stringify(request.args)).digest("hex"),
          resultDigest: result.evidenceHash,
          ok: result.ok
        });
        options.onEvent?.({ taskId: task.id, iteration, tool: request.tool, ok: result.ok });
        if (!result.ok && (result.errorCode?.startsWith("ACS_") || result.errorCode?.includes("AUTH")))
          return this.finish(
            task,
            {
              verdict: "BLOCK",
              evidence: observations.map((item) => item.evidenceHash),
              reason: "ACS authorization denied"
            },
            observations,
            iteration + 1
          );
      }
      if (turn.toolCalls.length === 0)
        return this.finish(
          task,
          await this.deps.verification.run(task, options.signal ?? new AbortController().signal),
          observations,
          iteration + 1
        );
      task = { ...task, state: "execute" };
    }
    return this.finish(
      task,
      { verdict: "BLOCK", evidence: observations.map((item) => item.evidenceHash), reason: "iteration limit reached" },
      observations,
      maxIterations
    );
  }
  private async finish(
    task: CodingTask,
    verdict: Verdict,
    observations: ToolObservation[],
    iterations: number,
    turn?: AgentTurn
  ): Promise<CodingLoopResult> {
    const finalTask = {
      ...task,
      state:
        verdict.verdict === "PASS"
          ? ("complete" as const)
          : verdict.verdict === "BLOCK"
            ? ("blocked" as const)
            : ("verify" as const)
    };
    await this.deps.store.save(finalTask, { type: "final_verdict", verdict });
    await this.deps.audit.append({
      taskId: task.id,
      type: "final_verdict",
      verdict: verdict.verdict,
      evidence: verdict.evidence
    });
    return { task: finalTask, turn: turn ?? { toolCalls: [] }, verdict, iterations, observations };
  }
}
