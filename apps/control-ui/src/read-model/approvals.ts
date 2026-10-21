import type { ApprovalsReadModel, Viewer } from "@agent-control-stack/mission-control-contract";
import { redactSecrets } from "../redaction.js";
import type { MissionControlViewModel } from "../types.js";

const DEFAULT_SLA_MS = 30 * 60 * 1000;
const text = (value: unknown, max: number): string => {
  const redacted = redactSecrets(value);
  return redacted.length > max ? `${redacted.slice(0, max - 1)}…` : redacted;
};

/**
 * Pure projection of work waiting on a human. `viewer` carries what the *credential*
 * may do so the UI can avoid offering a control that is certain to be refused; the
 * gateway re-checks everything on every POST. Hashes are the policy action
 * fingerprints needed to approve one bounded action; they are not secrets.
 */
export function toApprovalsReadModel(model: MissionControlViewModel, viewer: Viewer): ApprovalsReadModel {
  const now = (model.now ?? new Date()).getTime();
  const slaMs = model.approvalSlaMs && model.approvalSlaMs > 0 ? Math.floor(model.approvalSlaMs) : DEFAULT_SLA_MS;
  const options = model.approvalActionsByWorkItem ?? {};
  const items = model.workItems
    .filter((i): i is typeof i & { status: "needs_approval" | "blocked" } => i.status === "needs_approval" || i.status === "blocked")
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
    .slice(0, 500)
    .map((item) => {
      const since = Date.parse(item.updatedAt);
      return {
        id: item.id,
        title: text(item.title, 300),
        intent: text(item.intent, 500),
        status: item.status,
        risk: item.risk,
        requester: text(item.requester, 100),
        since: item.updatedAt,
        overSla: item.status === "needs_approval" && Number.isFinite(since) && now - since > slaMs,
        actions:
          item.status === "needs_approval"
            ? (options[item.id] ?? []).slice(0, 32).map((a) => ({ actionHash: a.actionHash, kind: text(a.kind, 100), description: text(a.description ?? "", 300) }))
            : []
      };
    });
  return { schemaVersion: 1, generatedAt: new Date(now).toISOString(), viewer, slaMs, items };
}
