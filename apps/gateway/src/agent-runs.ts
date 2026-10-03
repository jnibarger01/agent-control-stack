/**
 * Mission Control agent dispatch.
 *
 * A run is created only by an authenticated human operator, bound to the exact command they confirmed,
 * executed host-side in a fresh git worktree, and recorded in the hash-chained audit log
 * (`agent_run.*`). Agents, workers and service credentials cannot dispatch. Nothing here commits,
 * merges, pushes or promotes: the result is a branch in a worktree for a human to review.
 */
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  AGENT_CLI_CATALOG,
  AGENT_CLI_IDS,
  agentCliSpec,
  allowedRepoRoots,
  createDispatchWorktree,
  defaultWorktreeRoot,
  inspectWorktree,
  planAgentCommand,
  probeAllAgentClis,
  redactLines,
  resolveRepoRoot,
  runAgent,
  type AgentCliProbe,
  type AgentRunMode
} from "@agent-control-stack/agent-cli";
import { ControlStackError } from "@agent-control-stack/shared";
import type { StoredAuditEvent, WorkItemStore } from "@agent-control-stack/work-items";

export type AgentRunStatus =
  "queued" | "running" | "succeeded" | "failed" | "timed_out" | "cancelled" | "interrupted" | "rejected";

export interface AgentRunView {
  runId: string;
  agentId: string;
  mode: AgentRunMode;
  status: AgentRunStatus;
  repoRoot: string;
  actorId: string;
  requestedAt: string;
  startedAt?: string;
  finishedAt?: string;
  worktreePath?: string;
  branch?: string;
  exitCode?: number | null;
  durationMs?: number;
  promptPreview: string;
  changedFiles?: string[];
  diffStat?: string;
  commitsAhead?: number;
  truncated?: boolean;
  error?: string;
}

export interface AgentDispatchConfig {
  enabled: boolean;
  repoRoots: string[];
  maxConcurrent: number;
  worktreeRoot: string;
  outputRoot: string;
}

export const AGENT_RUN_EVENTS = {
  requested: "agent_run.requested",
  started: "agent_run.started",
  finished: "agent_run.finished",
  rejected: "agent_run.rejected",
  cancelRequested: "agent_run.cancel_requested",
  interrupted: "agent_run.interrupted"
} as const;

export function agentDispatchConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AgentDispatchConfig {
  const max = Number(env.ACS_AGENT_RUN_MAX_CONCURRENT ?? "3");
  if (!Number.isInteger(max) || max < 1 || max > 16) {
    throw new Error("ACS_AGENT_RUN_MAX_CONCURRENT must be an integer from 1 to 16");
  }
  const home = env.HOME ?? homedir();
  return {
    enabled: env.ACS_AGENT_DISPATCH_ENABLED === "1",
    repoRoots: allowedRepoRoots(env),
    maxConcurrent: max,
    worktreeRoot: defaultWorktreeRoot(env),
    outputRoot: resolve(env.ACS_AGENT_RUN_OUTPUT_ROOT?.trim() || join(home, ".acs", "agent-runs"))
  };
}

export interface DispatchRequest {
  agentId: string;
  prompt: string;
  repo: string;
  mode: AgentRunMode;
  timeoutSec?: number;
}

/** What the operator is shown and must confirm. The dispatch is refused if it hashes differently. */
export interface DispatchPreview {
  agentId: string;
  displayName: string;
  mode: AgentRunMode;
  repoRoot: string;
  timeoutSec: number;
  containment: string;
  branchPattern: string;
  promptChars: number;
  confirmationHash: string;
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

export class AgentRunService {
  private readonly active = new Map<string, AbortController>();

  constructor(
    private readonly store: Pick<WorkItemStore, "recordSystemEvent" | "readEvents">,
    readonly config: AgentDispatchConfig,
    private readonly deps: { probe?: () => Promise<AgentCliProbe[]> } = {}
  ) {}

  assertEnabled(): void {
    if (!this.config.enabled) {
      throw new ControlStackError(
        "agent_dispatch_disabled",
        "agent dispatch is off. Set ACS_AGENT_DISPATCH_ENABLED=1 and ACS_AGENT_REPO_ROOTS on the gateway."
      );
    }
    if (this.config.repoRoots.length === 0) {
      throw new ControlStackError("agent_dispatch_disabled", "ACS_AGENT_REPO_ROOTS lists no repositories");
    }
  }

  probes(): Promise<AgentCliProbe[]> {
    return (this.deps.probe ?? probeAllAgentClis)();
  }

  async preview(request: DispatchRequest): Promise<DispatchPreview> {
    this.assertEnabled();
    const spec = agentCliSpec(request.agentId);
    if (!spec) throw new ControlStackError("agent_not_supported", `unknown agent CLI: ${request.agentId}`);
    // Validates installed / blocked / mode / prompt exactly as dispatch will.
    planAgentCommand({
      agentId: spec.id,
      prompt: request.prompt,
      mode: request.mode,
      cwd: "/preview",
      ...(request.timeoutSec ? { timeoutSec: request.timeoutSec } : {})
    });
    const repoRoot = await resolveRepoRoot(request.repo, this.config.repoRoots);
    const timeoutSec = planAgentCommand({
      agentId: spec.id,
      prompt: request.prompt,
      mode: request.mode,
      cwd: "/preview",
      ...(request.timeoutSec ? { timeoutSec: request.timeoutSec } : {})
    }).timeoutSec;
    return {
      agentId: spec.id,
      displayName: spec.displayName,
      mode: request.mode,
      repoRoot,
      timeoutSec,
      containment:
        request.mode === "edit" ? spec.editContainment : "the CLI's own read-only mode; nothing should be written",
      branchPattern: `acs/agent/${spec.id}-<run id>`,
      promptChars: request.prompt.trim().length,
      confirmationHash: sha256(
        JSON.stringify({ agent: spec.id, mode: request.mode, repoRoot, timeoutSec, prompt: request.prompt.trim() })
      )
    };
  }

  /** Authorize and start a run. Returns once the run is recorded; execution continues in the background. */
  async dispatch(request: DispatchRequest, actorId: string, confirmationHash: string): Promise<AgentRunView> {
    const preview = await this.preview(request);
    if (confirmationHash !== preview.confirmationHash) {
      throw new ControlStackError("agent_confirmation_mismatch", "the confirmed command does not match this request");
    }
    if (this.active.size >= this.config.maxConcurrent) {
      throw new ControlStackError(
        "agent_run_capacity",
        `at most ${this.config.maxConcurrent} agent runs may be active`
      );
    }
    const runId = `run_${randomBytes(6).toString("hex")}`;
    const controller = new AbortController();
    this.active.set(runId, controller);
    const prompt = request.prompt.trim();
    const outDir = join(this.config.outputRoot, runId);
    try {
      mkdirSync(outDir, { recursive: true, mode: 0o700 });
      writeFileSync(join(outDir, "prompt.txt"), prompt, { mode: 0o600 });
      this.store.recordSystemEvent({
        name: AGENT_RUN_EVENTS.requested,
        body: {
          runId,
          agentId: preview.agentId,
          mode: preview.mode,
          repoRoot: preview.repoRoot,
          timeoutSec: preview.timeoutSec,
          actorId,
          confirmationHash: preview.confirmationHash,
          promptSha256: sha256(prompt),
          promptPreview: redactLines(prompt).slice(0, 240)
        },
        attributes: { "agent_run.id": runId, "agent_run.agent": preview.agentId }
      });
    } catch (error) {
      this.active.delete(runId);
      throw error;
    }
    void this.execute(runId, preview, prompt, controller, outDir);
    return this.get(runId)!;
  }

  private async execute(
    runId: string,
    preview: DispatchPreview,
    prompt: string,
    controller: AbortController,
    outDir: string
  ): Promise<void> {
    const attrs = { "agent_run.id": runId, "agent_run.agent": preview.agentId };
    let worktree;
    try {
      worktree = await createDispatchWorktree({
        repoRoot: preview.repoRoot,
        runId,
        agentId: preview.agentId,
        worktreeRoot: this.config.worktreeRoot
      });
      const command = planAgentCommand({
        agentId: preview.agentId,
        prompt,
        mode: preview.mode,
        cwd: worktree.worktreePath,
        timeoutSec: preview.timeoutSec
      });
      const outputPath = join(outDir, "output.log");
      this.store.recordSystemEvent({
        name: AGENT_RUN_EVENTS.started,
        body: {
          runId,
          worktreePath: worktree.worktreePath,
          branch: worktree.branch,
          baseCommit: worktree.baseCommit,
          binary: command.binaryPath,
          commandHash: command.commandHash
        },
        attributes: attrs
      });
      const result = await runAgent({
        command,
        cwd: worktree.worktreePath,
        signal: controller.signal,
        onSnapshot: (text) => writeAtomic(outputPath, text)
      });
      writeAtomic(outputPath, result.output);
      const changes = await inspectWorktree(worktree).catch(() => undefined);
      this.store.recordSystemEvent({
        name: AGENT_RUN_EVENTS.finished,
        body: {
          runId,
          outcome: result.outcome,
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          outputSha256: result.outputSha256,
          truncated: result.truncated,
          ...(changes
            ? {
                changedFiles: changes.changedFiles.slice(0, 50),
                diffStat: changes.diffStat.slice(-1_000),
                commitsAhead: changes.commitsAhead
              }
            : {})
        },
        attributes: attrs
      });
    } catch (error) {
      const message = redactLines(error instanceof Error ? error.message : String(error)).slice(0, 500);
      try {
        this.store.recordSystemEvent({
          name: AGENT_RUN_EVENTS.finished,
          body: {
            runId,
            outcome: "failed",
            exitCode: null,
            durationMs: 0,
            error: message,
            startedBeforeFailure: Boolean(worktree)
          },
          attributes: attrs
        });
      } catch {
        /* the audit sink is the only record; nothing more can be done here */
      }
    } finally {
      this.active.delete(runId);
    }
  }

  cancel(runId: string, actorId: string): AgentRunView {
    const run = this.get(runId);
    if (!run) throw new ControlStackError("agent_run_not_found", "agent run not found");
    const controller = this.active.get(runId);
    if (!controller) throw new ControlStackError("agent_run_not_active", "agent run is not active");
    this.store.recordSystemEvent({
      name: AGENT_RUN_EVENTS.cancelRequested,
      body: { runId, actorId },
      attributes: { "agent_run.id": runId }
    });
    controller.abort();
    return this.get(runId)!;
  }

  /** Runs recorded as active but with no process in this gateway died with a previous gateway. */
  reconcile(): number {
    let count = 0;
    for (const run of this.list(200)) {
      if ((run.status === "queued" || run.status === "running") && !this.active.has(run.runId)) {
        this.store.recordSystemEvent({
          name: AGENT_RUN_EVENTS.interrupted,
          body: { runId: run.runId, reason: "gateway restarted before the run finished" },
          attributes: { "agent_run.id": run.runId }
        });
        count += 1;
      }
    }
    return count;
  }

  shutdown(): void {
    for (const controller of this.active.values()) controller.abort();
  }

  activeCount(): number {
    return this.active.size;
  }

  list(limit = 50): AgentRunView[] {
    const events = Object.values(AGENT_RUN_EVENTS).flatMap((name) => this.store.readEvents({ name, limit: 500 }));
    return foldRuns(events).slice(0, limit);
  }

  get(runId: string): AgentRunView | undefined {
    return this.list(500).find((run) => run.runId === runId);
  }

  readOutput(runId: string, maxChars = 60_000): string | undefined {
    if (!/^run_[a-f0-9]{12}$/u.test(runId)) return undefined;
    try {
      const text = readFileSync(join(this.config.outputRoot, runId, "output.log"), "utf8");
      return text.length > maxChars ? `…\n${text.slice(-maxChars)}` : text;
    } catch {
      return undefined;
    }
  }

  catalog(): { id: string; displayName: string }[] {
    return AGENT_CLI_IDS.map((id) => ({ id, displayName: AGENT_CLI_CATALOG[id].displayName }));
  }
}

function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

function iso(event: StoredAuditEvent): string {
  const nano = Number(event.timeUnixNano);
  return Number.isFinite(nano) ? new Date(Math.floor(nano / 1e6)).toISOString() : new Date(0).toISOString();
}

/** Rebuild run state from the audit events, oldest first, then return newest runs first. */
export function foldRuns(events: StoredAuditEvent[]): AgentRunView[] {
  const runs = new Map<string, AgentRunView>();
  for (const event of [...events].sort((a, b) => a.sequence - b.sequence)) {
    const body = event.body as Record<string, unknown>;
    const runId = typeof body.runId === "string" ? body.runId : undefined;
    if (!runId) continue;
    const at = iso(event);
    if (event.name === AGENT_RUN_EVENTS.requested) {
      runs.set(runId, {
        runId,
        agentId: String(body.agentId ?? ""),
        mode: body.mode === "read-only" ? "read-only" : "edit",
        status: "queued",
        repoRoot: String(body.repoRoot ?? ""),
        actorId: String(body.actorId ?? ""),
        requestedAt: at,
        promptPreview: String(body.promptPreview ?? "")
      });
      continue;
    }
    const run = runs.get(runId);
    if (!run) continue;
    if (event.name === AGENT_RUN_EVENTS.started) {
      run.status = "running";
      run.startedAt = at;
      if (typeof body.worktreePath === "string") run.worktreePath = body.worktreePath;
      if (typeof body.branch === "string") run.branch = body.branch;
    } else if (event.name === AGENT_RUN_EVENTS.finished) {
      const outcome = body.outcome;
      run.status = outcome === "succeeded" || outcome === "timed_out" || outcome === "cancelled" ? outcome : "failed";
      run.finishedAt = at;
      run.exitCode = typeof body.exitCode === "number" ? body.exitCode : null;
      if (typeof body.durationMs === "number") run.durationMs = body.durationMs;
      if (Array.isArray(body.changedFiles)) run.changedFiles = body.changedFiles.map(String);
      if (typeof body.diffStat === "string") run.diffStat = body.diffStat;
      if (typeof body.commitsAhead === "number") run.commitsAhead = body.commitsAhead;
      if (typeof body.truncated === "boolean") run.truncated = body.truncated;
      if (typeof body.error === "string") run.error = body.error;
    } else if (event.name === AGENT_RUN_EVENTS.interrupted) {
      if (run.status === "queued" || run.status === "running") {
        run.status = "interrupted";
        run.finishedAt = at;
        run.error = String(body.reason ?? "interrupted");
      }
    }
  }
  return [...runs.values()].sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
}
