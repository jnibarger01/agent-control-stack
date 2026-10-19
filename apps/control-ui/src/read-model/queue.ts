import type { QueueItem, QueueReadModel } from "@agent-control-stack/mission-control-contract";
import type { WorkItem } from "@agent-control-stack/work-items";
import { redactSecrets } from "../redaction.js";
import { executionStage } from "../render/operations.js";
import type { MissionControlViewModel } from "../types.js";

const text = (value: unknown, max: number): string => {
  const redacted = redactSecrets(value);
  return redacted.length > max ? `${redacted.slice(0, max - 1)}…` : redacted;
};

/**
 * Pure projection of the dashboard window into the queue read model. Never
 * forwards target paths, action params, results or metadata. Plan state is
 * `unknown` when the gateway supplied no plan data, never inferred from status.
 */
export function toQueueReadModel(model: MissionControlViewModel): QueueReadModel {
  const plans = model.executionPlansByWorkItem;
  const admissions = model.executionPlanAdmissionsByWorkItem;
  const attempts = model.executionAttemptsByWorkItem ?? {};
  const leases = model.attemptLeasesByWorkItem ?? {};

  const items: QueueItem[] = [...model.workItems]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 1000)
    .map((item: WorkItem) => {
      const plan = plans?.[item.id];
      const admission = admissions?.[item.id];
      const latest = attempts[item.id]?.at(-1);
      const lease = (leases[item.id] ?? []).reduce<(typeof leases)[string][number] | undefined>(
        (best, l) => (l.status === "active" && (!best || l.fencingEpoch > best.fencingEpoch) ? l : best),
        undefined
      );
      const lineage =
        item.sourceWorkItemId || item.rootWorkItemId || item.retrySequence !== undefined
          ? {
              ...(item.retrySequence !== undefined ? { retrySequence: item.retrySequence } : {}),
              ...(item.sourceWorkItemId ? { sourceWorkItemId: item.sourceWorkItemId } : {}),
              ...(item.rootWorkItemId ? { rootWorkItemId: item.rootWorkItemId } : {}),
              ...(item.lineageType ? { type: String(item.lineageType) } : {})
            }
          : undefined;
      return {
        id: item.id,
        title: text(item.title, 300),
        intent: text(item.intent, 500),
        status: item.status,
        stageLabel: executionStage(item, latest),
        risk: item.risk,
        requester: text(item.requester, 100),
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        ...(lineage ? { lineage } : {}),
        plan:
          plans === undefined
            ? { state: "unknown" as const }
            : !plan
              ? { state: "none" as const }
              : admission
                ? { state: "admitted" as const, planNumber: plan.planNumber, requiresApproval: admission.requiresApproval }
                : { state: "drafted" as const, planNumber: plan.planNumber },
        ...(latest ? { attempt: { status: latest.status, number: latest.attemptNumber, ...(latest.claimedByWorkerId ? { workerId: text(latest.claimedByWorkerId, 200) } : {}) } } : {}),
        ...(lease ? { lease: { status: lease.status, fencingEpoch: lease.fencingEpoch, workerId: text(lease.workerId, 200), expiresAt: lease.expiresAt } } : {})
      };
    });

  const byStatus: Record<string, number> = {};
  if (model.statusCounts) {
    for (const [k, v] of Object.entries(model.statusCounts)) if (Number.isFinite(v)) byStatus[k] = Math.max(0, Math.floor(v));
  } else {
    for (const i of model.workItems) byStatus[i.status] = (byStatus[i.status] ?? 0) + 1;
  }
  return {
    schemaVersion: 1,
    generatedAt: (model.now ?? new Date()).toISOString(),
    counts: { source: model.statusCounts ? "store" : "window", byStatus },
    ...(model.finishedWorkItems ? { finishedWindow: { shown: model.finishedWorkItems.shown, total: model.finishedWorkItems.total } } : {}),
    items
  };
}
