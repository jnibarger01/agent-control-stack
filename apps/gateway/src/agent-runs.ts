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
  summarizeToolLog,
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
  /** What ACS verified about the result, independent of the CLI's exit code. */
  resultCheck?: AgentResultCheck;
  /** Human review state. A succeeded run is `pending_review` until an operator accepts or rejects it. */
  acceptance: AgentRunAcceptance;
  /** Tool calls seen by the ACS tool guard (Claude Code only). Absent when the CLI has no guard. */
  toolCalls?: { total: number; denied: number; deniedCalls: Array<{ tool: string; reason: string }> };
  reviewedBy?: string;
  reviewedAt?: string;
  reviewNote?: string;
}

export type AgentResultCheck =
  "changes_present" | "no_changes" | "unexpected_changes" | "inspection_failed" | "failure_signature";
export type AgentRunAcceptance = "pending_review" | "accepted" | "rejected" | "not_applicable";

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
  interrupted: "agent_run.interrupted",
  processStarted: "agent_run.process_started",
  reviewed: "agent_run.reviewed"
} as const;

/** A preview is only dispatchable for this long, and only by the operator it was issued to. */
export const PREVIEW_TTL_MS = 10 * 60_000;
const MAX_ISSUED_PREVIEWS = 500;

/** Output that means the CLI never did the work even though it exited 0 (e.g. goose on a 401). */
const FAILURE_SIGNATURES = [
  /invalid api key/iu,
  /IneligibleTierError/u,
  /\b401\b[^\n]*unauthori[sz]ed|unauthori[sz]ed[^\n]*\b401\b/iu,
  /not (?:logged|signed) in/iu,
  /authentication (?:failed|required|error)/iu,
  /please (?:log ?in|sign ?in|re-?authenticate)/iu,
  /(?:token|login|session) (?:has )?expired/iu
];

export interface ResultAssessment {
  outcome: "succeeded" | "failed" | "timed_out" | "cancelled";
  resultCheck?: AgentResultCheck;
  error?: string;
}

/**
 * Decide what a finished run means. A zero exit code only says the process ended: the result must also show
 * the work happened (or, for read-only, that nothing was written). The CLI's own report is kept separately.
 */
export function assessResult(
  mode: AgentRunMode,
  reported: { outcome: ResultAssessment["outcome"]; output: string },
  changes: { changedFiles: string[]; commitsAhead: number } | undefined
): ResultAssessment {
  if (reported.outcome !== "succeeded") return { outcome: reported.outcome };
  if (!changes) {
    return {
      outcome: "failed",
      resultCheck: "inspection_failed",
      error: "exited 0 but the worktree could not be inspected, so the result is unverified"
    };
  }
  const produced = changes.changedFiles.length > 0 || changes.commitsAhead > 0;
  if (mode === "read-only" && produced) {
    return {
      outcome: "failed",
      resultCheck: "unexpected_changes",
      error: "read-only run modified its worktree; the CLI's read-only mode did not hold"
    };
  }
  if (!produced && FAILURE_SIGNATURES.some((pattern) => pattern.test(reported.output.slice(-4_000)))) {
    return {
      outcome: "failed",
      resultCheck: "failure_signature",
      error: "exited 0 with no changes and output that reads as an authentication or provider failure"
    };
  }
  return { outcome: "succeeded", resultCheck: produced ? "changes_present" : "no_changes" };
}

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

interface IssuedPreview {
  actorId: string;
  expiresAt: number;
  /** Set once a run has claimed this confirmation; a repeat dispatch returns that run instead of a new one. */
  runId?: string;
}

export class AgentRunService {
  private readonly active = new Map<string, AbortController>();
  private readonly issued = new Map<string, IssuedPreview>();

  constructor(
    private readonly store: Pick<WorkItemStore, "recordSystemEvent" | "readEvents">,
    readonly config: AgentDispatchConfig,
    private readonly deps: { probe?: () => Promise<AgentCliProbe[]>; now?: () => number } = {}
  ) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

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

  /** Validate a request and issue a confirmation bound to `actorId` that expires after PREVIEW_TTL_MS. */
  async preview(request: DispatchRequest, actorId: string): Promise<DispatchPreview> {
    const preview = await this.validate(request);
    this.remember(preview.confirmationHash, actorId);
    return preview;
  }

  private remember(hash: string, actorId: string): void {
    const now = this.now();
    for (const [key, entry] of this.issued) {
      if (entry.expiresAt <= now && !entry.runId) this.issued.delete(key);
    }
    while (this.issued.size >= MAX_ISSUED_PREVIEWS) {
      const oldest = this.issued.keys().next().value;
      if (oldest === undefined) break;
      this.issued.delete(oldest);
    }
    const existing = this.issued.get(hash);
    // Re-previewing an identical, already-claimed request must not reopen it for a second run.
    if (existing?.runId && existing.actorId === actorId) return;
    this.issued.set(hash, { actorId, expiresAt: now + PREVIEW_TTL_MS });
  }

  private async validate(request: DispatchRequest): Promise<DispatchPreview> {
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
    const preview = await this.validate(request);
    if (confirmationHash !== preview.confirmationHash) {
      throw new ControlStackError("agent_confirmation_mismatch", "the confirmed command does not match this request");
    }
    // Everything from here to `issued.runId = runId` is synchronous, so two identical submissions cannot both claim.
    const issued = this.issued.get(confirmationHash);
    if (!issued || issued.actorId !== actorId) {
      throw new ControlStackError(
        "agent_confirmation_unissued",
        "this command was not previewed by you on this gateway; review and confirm it again"
      );
    }
    if (issued.runId) {
      const existing = this.get(issued.runId);
      if (existing) return existing;
    }
    if (issued.expiresAt <= this.now()) {
      this.issued.delete(confirmationHash);
      throw new ControlStackError(
        "agent_confirmation_expired",
        "the confirmation expired; review and confirm it again"
      );
    }
    if (this.active.size >= this.config.maxConcurrent) {
      throw new ControlStackError(
        "agent_run_capacity",
        `at most ${this.config.maxConcurrent} agent runs may be active`
      );
    }
    const runId = `run_${randomBytes(6).toString("hex")}`;
    // Fences every later event of this run: a result written by anything but this execution is ignored.
    const ownerToken = randomBytes(8).toString("hex");
    issued.runId = runId;
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
          ownerToken,
          promptSha256: sha256(prompt),
          promptPreview: redactLines(prompt).slice(0, 240)
        },
        attributes: { "agent_run.id": runId, "agent_run.agent": preview.agentId }
      });
    } catch (error) {
      this.active.delete(runId);
      delete issued.runId;
      throw error;
    }
    void this.execute(runId, ownerToken, preview, prompt, controller, outDir);
    return this.get(runId)!;
  }

  private async execute(
    runId: string,
    ownerToken: string,
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
      const toolLogPath = join(outDir, "tool-calls.jsonl");
      const command = planAgentCommand({
        agentId: preview.agentId,
        prompt,
        mode: preview.mode,
        cwd: worktree.worktreePath,
        timeoutSec: preview.timeoutSec,
        toolGuardLog: toolLogPath
      });
      const outputPath = join(outDir, "output.log");
      this.store.recordSystemEvent({
        name: AGENT_RUN_EVENTS.started,
        body: {
          runId,
          ownerToken,
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
        onStart: (pid) => {
          if (pid === undefined) return;
          try {
            this.store.recordSystemEvent({
              name: AGENT_RUN_EVENTS.processStarted,
              body: { runId, ownerToken, pid, startTicks: processStartTicks(pid) ?? null },
              attributes: attrs
            });
          } catch {
            /* the run proceeds; recovery then cannot identify the process and will say so */
          }
        },
        onSnapshot: (text) => writeAtomic(outputPath, text)
      });
      writeAtomic(outputPath, result.output);
      const changes = await inspectWorktree(worktree).catch(() => undefined);
      const assessed = assessResult(preview.mode, result, changes);
      let toolCalls: ReturnType<typeof summarizeToolLog> | undefined;
      if (preview.agentId === "claude") {
        try {
          toolCalls = summarizeToolLog(readFileSync(toolLogPath, "utf8"));
        } catch {
          toolCalls = { total: 0, denied: 0, deniedCalls: [] };
        }
      }
      this.store.recordSystemEvent({
        name: AGENT_RUN_EVENTS.finished,
        body: {
          runId,
          ownerToken,
          outcome: assessed.outcome,
          reportedOutcome: result.outcome,
          ...(assessed.resultCheck ? { resultCheck: assessed.resultCheck } : {}),
          ...(assessed.error ? { error: assessed.error } : {}),
          ...(toolCalls ? { toolCalls } : {}),
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
            ownerToken,
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

  /** Record an operator's accept/reject of a succeeded run. Nothing is promoted either way. */
  review(runId: string, actorId: string, decision: "accept" | "reject", note?: string): AgentRunView {
    const run = this.get(runId);
    if (!run) throw new ControlStackError("agent_run_not_found", "agent run not found");
    if (run.acceptance !== "pending_review") {
      throw new ControlStackError(
        "agent_run_not_reviewable",
        run.acceptance === "not_applicable"
          ? `a ${run.status} run cannot be accepted`
          : `this run was already ${run.acceptance}`
      );
    }
    this.store.recordSystemEvent({
      name: AGENT_RUN_EVENTS.reviewed,
      body: {
        runId,
        decision,
        actorId,
        ...(note ? { note: redactLines(note).slice(0, 500) } : {})
      },
      attributes: { "agent_run.id": runId }
    });
    return this.get(runId)!;
  }

  /**
   * Runs recorded as active but with no process in this gateway died with a previous gateway. A process that
   * outlived it is no longer under any authority, so it is terminated (only if its identity still matches the
   * recorded pid and start time) and the run is marked interrupted with what actually happened.
   */
  reconcile(): number {
    let count = 0;
    const processes = new Map<string, { pid: number; startTicks: number | null }>();
    for (const event of this.store.readEvents({ name: AGENT_RUN_EVENTS.processStarted, limit: 500 })) {
      const body = event.body as Record<string, unknown>;
      if (typeof body.runId === "string" && typeof body.pid === "number") {
        processes.set(body.runId, {
          pid: body.pid,
          startTicks: typeof body.startTicks === "number" ? body.startTicks : null
        });
      }
    }
    for (const run of this.list(200)) {
      if ((run.status === "queued" || run.status === "running") && !this.active.has(run.runId)) {
        const recorded = processes.get(run.runId);
        const fate = recorded ? terminateOrphan(recorded.pid, recorded.startTicks) : "no_process_recorded";
        this.store.recordSystemEvent({
          name: AGENT_RUN_EVENTS.interrupted,
          body: {
            runId: run.runId,
            reason: `gateway restarted before the run finished (${ORPHAN_FATE_TEXT[fate]})`,
            orphan: fate
          },
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

export type OrphanFate = "terminated" | "already_exited" | "identity_unverified" | "no_process_recorded";
const ORPHAN_FATE_TEXT: Record<OrphanFate, string> = {
  terminated: "its orphaned agent process was terminated",
  already_exited: "its agent process had already exited",
  identity_unverified: "its agent process may still be running; it could not be verified, so it was left alone",
  no_process_recorded: "no agent process was recorded"
};

/** Field 22 of /proc/<pid>/stat: start time in clock ticks since boot. Identifies a process across pid reuse. */
export function processStartTicks(pid: number): number | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const ticks = Number(fields[19]);
    return Number.isFinite(ticks) ? ticks : undefined;
  } catch {
    return undefined;
  }
}

function terminateOrphan(pid: number, recordedTicks: number | null): OrphanFate {
  let alive = true;
  try {
    process.kill(pid, 0);
  } catch (error) {
    alive = (error as NodeJS.ErrnoException).code === "EPERM";
  }
  if (!alive) return "already_exited";
  const current = processStartTicks(pid);
  if (current === undefined) return "already_exited";
  if (recordedTicks === null || current !== recordedTicks) {
    // Same pid, different (or unrecorded) process: never signal something we cannot prove is ours.
    return recordedTicks === null ? "identity_unverified" : "already_exited";
  }
  try {
    process.kill(-pid, "SIGTERM");
    setTimeout(() => {
      try {
        if (processStartTicks(pid) === recordedTicks) process.kill(-pid, "SIGKILL");
      } catch {
        /* gone */
      }
    }, 2_000).unref();
    return "terminated";
  } catch {
    return "identity_unverified";
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
  const owners = new Map<string, unknown>();
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
        promptPreview: String(body.promptPreview ?? ""),
        acceptance: "not_applicable"
      });
      owners.set(runId, body.ownerToken);
      continue;
    }
    const run = runs.get(runId);
    if (!run) continue;
    if (event.name === AGENT_RUN_EVENTS.reviewed) {
      if (run.acceptance === "pending_review") {
        run.acceptance = body.decision === "accept" ? "accepted" : "rejected";
        run.reviewedBy = String(body.actorId ?? "");
        run.reviewedAt = at;
        if (typeof body.note === "string") run.reviewNote = body.note;
      }
      continue;
    }
    // Only the execution that was authorised may start or finish a run, and a terminal state is final.
    const terminal = !(run.status === "queued" || run.status === "running");
    if (event.name === AGENT_RUN_EVENTS.started || event.name === AGENT_RUN_EVENTS.finished) {
      if (terminal || body.ownerToken !== owners.get(runId)) continue;
    }
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
      if (body.toolCalls && typeof body.toolCalls === "object") {
        run.toolCalls = body.toolCalls as NonNullable<AgentRunView["toolCalls"]>;
      }
      if (typeof body.resultCheck === "string") run.resultCheck = body.resultCheck as AgentResultCheck;
      if (run.status === "succeeded") run.acceptance = "pending_review";
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
