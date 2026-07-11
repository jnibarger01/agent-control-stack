import { runAggregator } from "./aggregator.js";
import { sanitizeMoaAuditPayload } from "./audit.js";
import { buildBoundedContext, runAdvisor, type AdvisorRun } from "./advisor.js";
import type { MoaConfig, MoaPreset } from "./config.js";
import { MoaError } from "./errors.js";
import type { AcsClient, AuditSink, ModelCaller, MoaAuditEvent, Redactor } from "./ports.js";
import { type AggregatorDecision, type DecisionKind, type HighRiskCategory, type TaskEnvelope, TaskEnvelopeSchema } from "./types.js";
import { sha256, stableStringify } from "./util.js";

export interface OrchestratorDeps {
  caller: ModelCaller;
  acs: AcsClient;
  audit: AuditSink;
  redactor: Redactor;
  now?: () => string;
  timeouts?: { advisorMs?: number; aggregatorMs?: number };
  auditRawPayloads?: boolean;
}

export interface MoaRunResult {
  task_id: string;
  mode: "moa";
  preset: string;
  advisor_count: number;
  decision: DecisionKind;
  acs_work_item_id: string | null;
  summary: string;
  user_response: string;
}

export async function runMoaTask(
  deps: OrchestratorDeps,
  config: MoaConfig,
  presetName: string,
  taskInput: unknown,
  actor: string
): Promise<MoaRunResult> {
  const now = deps.now ?? (() => new Date().toISOString());
  const advisorMs = deps.timeouts?.advisorMs ?? 60_000;
  const aggregatorMs = deps.timeouts?.aggregatorMs ?? 120_000;
  const parsed = TaskEnvelopeSchema.safeParse(taskInput);
  if (!parsed.success) {
    throw new MoaError("ENVELOPE_INVALID", "task envelope rejected (fail closed)", parsed.error.issues);
  }
  const task = parsed.data;
  const preset = config.presets[presetName];
  if (!preset) {
    throw new MoaError("PRESET_UNKNOWN", `unknown preset "${presetName}" (fail closed)`);
  }
  const base = { task_id: task.task_id, session_id: task.session_id, origin: task.origin, preset: presetName, actor };
  const emit = (type: MoaAuditEvent["type"], data: Record<string, unknown>) =>
    deps.audit.record({
      ts: now(),
      type,
      ...base,
      data: sanitizeMoaAuditPayload(type, data, { debugRawPayloads: deps.auditRawPayloads })
    });

  await emit("moa_run_started", {
    advisor_ids: preset.advisors.map((advisor) => advisor.id),
    aggregator_id: preset.aggregator.id,
    declared_risk: task.risk,
    kind: task.kind,
    goal: task.goal
  });

  const context = buildBoundedContext(task, deps.redactor);
  const settled = await Promise.allSettled(
    preset.advisors.map((advisor) => runAdvisor({ caller: deps.caller }, advisor, task, context, advisorMs))
  );
  const runs: AdvisorRun[] = settled.map((entry, index) =>
    entry.status === "fulfilled"
      ? entry.value
      : { ok: false, advisor_id: preset.advisors[index]!.id, reason: String(entry.reason) }
  );
  for (const run of runs) {
    if (run.ok) {
      await emit("moa_advisor_completed", {
        advisor_id: run.advisor_id,
        output: run.output,
        input_sha256: run.input_sha256,
        output_sha256: run.output_sha256,
        context_truncated: context.truncated
      });
    } else {
      await emit("moa_advisor_failed", { advisor_id: run.advisor_id, reason: run.reason });
    }
  }
  const failed = runs.filter((run) => !run.ok);
  if (failed.length) {
    await emit("moa_run_failed_closed", { stage: "advisor", failed_advisors: failed.map((run) => run.advisor_id) });
    throw new MoaError("ADVISOR_FAILED", `advisor(s) failed: ${failed.map((run) => run.advisor_id).join(", ")} (fail closed)`);
  }

  const outputs = runs.map((run) => (run as Extract<AdvisorRun, { ok: true }>).output);
  const policySummary = await deps.acs.policySummary(task);
  let agg;
  try {
    agg = await runAggregator({ caller: deps.caller }, preset.aggregator, task, outputs, policySummary, aggregatorMs);
  } catch (error) {
    await emit("moa_run_failed_closed", { stage: "aggregator", reason: error instanceof Error ? error.message : String(error) });
    throw error instanceof MoaError ? error : new MoaError("AGGREGATOR_INVALID", "aggregator failed (fail closed)", error);
  }
  await emit("moa_aggregator_decision", {
    aggregator_id: preset.aggregator.id,
    decision: agg.decision,
    input_sha256: agg.input_sha256,
    output_sha256: agg.output_sha256
  });

  try {
    const result = await applyDecision(deps, emit, task, preset, presetName, agg.decision, actor);
    await emit("moa_run_completed", { decision: result.decision, acs_work_item_id: result.acs_work_item_id });
    return result;
  } catch (error) {
    await emit("moa_run_failed_closed", { stage: "decision", reason: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

async function applyDecision(
  deps: OrchestratorDeps,
  emit: (type: MoaAuditEvent["type"], data: Record<string, unknown>) => void | Promise<void>,
  task: TaskEnvelope,
  preset: MoaPreset,
  presetName: string,
  decision: AggregatorDecision,
  actor: string
): Promise<MoaRunResult> {
  const finish = (kind: DecisionKind, workItemId: string | null, summary: string): MoaRunResult => ({
    task_id: task.task_id,
    mode: "moa",
    preset: presetName,
    advisor_count: preset.advisors.length,
    decision: kind,
    acs_work_item_id: workItemId,
    summary,
    user_response: decision.user_response
  });
  switch (decision.decision) {
    case "read_only_answer":
    case "ask_for_more_context":
    case "reject_task":
      if (decision.proposed_action?.requires_mutation && decision.decision !== "reject_task") {
        throw new MoaError("DECISION_INCONSISTENT", "mutation proposed on non-actionable decision (fail closed)");
      }
      await emit("moa_acs_action", { action: "none", decision: decision.decision });
      return finish(decision.decision, null, decision.advisor_synthesis.consensus.slice(0, 300));
    case "create_work_item":
    case "request_approval": {
      const expectedActionHash = proposedActionHash(decision);
      const category = decision.proposed_action!.category;
      const highRisk = category !== "read_only" && (preset.require_human_approval_for as string[]).includes(category as HighRiskCategory);
      const requiresApproval = decision.decision === "request_approval" || highRisk || decision.risk === "medium" || decision.risk === "high";
      const workItem = await deps.acs.createWorkItem({
        task_id: task.task_id,
        session_id: task.session_id,
        actor,
        title: `[moa:${presetName}] ${task.goal.slice(0, 120)}`,
        category,
        summary: decision.proposed_action!.summary,
        risk: decision.risk,
        requires_approval: requiresApproval,
        expected_action_hash: expectedActionHash,
        source: "moa_aggregator"
      });
      const finalDecision: DecisionKind = requiresApproval ? "request_approval" : "create_work_item";
      await emit("moa_acs_action", {
        action: "create_work_item",
        work_item_id: workItem.work_item_id,
        requires_approval: requiresApproval,
        aggregator_requested: decision.decision,
        escalated: finalDecision !== decision.decision,
        category,
        expected_action_hash: expectedActionHash
      });
      return finish(finalDecision, workItem.work_item_id, requiresApproval ? `Mutation gated behind ACS approval (work item ${workItem.work_item_id}).` : `ACS work item ${workItem.work_item_id} created.`);
    }
    case "execute_approved_work": {
      const expectedActionHash = proposedActionHash(decision);
      const workItemId = decision.acs_work_item!.work_item_id;
      let grant;
      try {
        grant = await deps.acs.getExecutableGrant({
          work_item_id: workItemId,
          actor,
          task_id: task.task_id,
          session_id: task.session_id,
          source: "moa_aggregator",
          expected_category: decision.proposed_action!.category,
          expected_action_hash: expectedActionHash
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        await emit("moa_execution_blocked", { work_item_id: workItemId, expected_action_hash: expectedActionHash, reason });
        throw new MoaError("EXECUTION_NOT_APPROVED", `work item ${workItemId} is not executable for this MoA grant: ${reason} (fail closed)`);
      }
      const dispatched = await deps.acs.requestExecution({
        work_item_id: workItemId,
        actor,
        grant_id: grant.grant_id,
        lease_token: grant.lease_token,
        expected_action_hash: expectedActionHash
      });
      if (!dispatched.dispatched) {
        await emit("moa_execution_blocked", { work_item_id: workItemId, expected_action_hash: expectedActionHash, reason: dispatched.reason });
        throw new MoaError("EXECUTION_NOT_APPROVED", `ACS refused dispatch for ${workItemId}: ${dispatched.reason ?? "unspecified"} (fail closed)`);
      }
      await emit("moa_acs_action", { action: "execute_approved_work", work_item_id: workItemId, expected_action_hash: expectedActionHash });
      return finish("execute_approved_work", workItemId, `ACS accepted approved work item ${workItemId} for worker claim.`);
    }
  }
}

function proposedActionHash(decision: AggregatorDecision): string {
  if (!decision.proposed_action) {
    throw new MoaError("DECISION_INCONSISTENT", `${decision.decision} requires proposed_action for ACS binding (fail closed)`);
  }
  return sha256(stableStringify(decision.proposed_action));
}
