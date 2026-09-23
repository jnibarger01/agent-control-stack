import type { ExecutionAttempt, ExecutionPlanRecord, SafeLease, StoredAuditEvent } from "../api/types";
import { admissionFor, currentPlan, leaseRemainingMs } from "../domain/execution";
import { attemptStatusMeta, leaseStatusMeta } from "../domain/status";
import { formatDuration, formatTime, shortHash, shortId } from "../domain/format";
import { Badge, CopyButton, KV } from "./ui";
import { DataTable } from "./DataTable";
import { EventTimeline } from "./EventTimeline";

/**
 * Plans, admissions, attempts and leases for one work item. The current plan
 * comes from its authenticated projection; admission remains audit-derived. Lease rows are the gateway's
 * sanitized projection and never contain a token or token hash.
 */
export function ExecutionDetailView({
  workItemId,
  executionPlan,
  attempts,
  leases,
  events,
  result,
  now
}: {
  workItemId: string;
  executionPlan?: ExecutionPlanRecord | null | undefined;
  attempts: readonly ExecutionAttempt[];
  leases: readonly SafeLease[];
  events: readonly StoredAuditEvent[];
  /** WorkItem.result as recorded by ACS; artifacts are read from it when present. */
  result?: Record<string, unknown> | undefined;
  now: number;
}) {
  const plan = executionPlan ?? currentPlan(events);
  const admission = admissionFor(events, plan);
  const artifacts = Array.isArray(result?.artifacts) ? (result.artifacts as Array<Record<string, unknown>>) : [];
  const executionEvents = events.filter((event) =>
    /^(execution|attempt|attempt_lease|execution_attempt|execution_plan|workspace_allocation|validation)[._]/u.test(
      event.name
    )
  );
  const ordered = [...attempts].sort((a, b) => b.attemptNumber - a.attemptNumber);
  const latest = ordered[0];
  const latestLease = latest
    ? [...leases]
        .filter((lease) => lease.attemptId === latest.attemptId)
        .sort((a, b) => b.fencingEpoch - a.fencingEpoch)[0]
    : undefined;

  return (
    <div className="stack" data-testid="execution-detail">
      <div className="section">
        <h3 className="eyebrow">Execution plan</h3>
        {plan ? (
          <KV
            items={[
              [
                "Plan",
                <span className="mono" key="p">
                  {plan.planId}
                  {plan.planNumber ? ` (#${plan.planNumber})` : ""}
                </span>
              ],
              [
                "Plan hash",
                <span className="hash" key="h">
                  {plan.planHash} <CopyButton value={plan.planHash} label="plan hash" />
                </span>
              ],
              ["Created by", plan.createdByActorId ?? "—"]
            ]}
          />
        ) : (
          <p className="muted">No execution plan has been drafted for {workItemId}.</p>
        )}
        {executionPlan && (
          <div className="section">
            <p>{executionPlan.definition.objective}</p>
            <ol>
              {executionPlan.definition.steps.map((step) => (
                <li key={step.stepId}>
                  <strong>{step.action.kind}</strong> · {step.action.description}
                </li>
              ))}
            </ol>
            <KV
              items={[
                ["Execution mode", executionPlan.definition.constraints.executionMode],
                ["Network", executionPlan.definition.constraints.network],
                ["Runtime limit", formatDuration(executionPlan.definition.constraints.maxRuntimeMs)]
              ]}
            />
          </div>
        )}
      </div>

      <div className="section">
        <h3 className="eyebrow">Admission</h3>
        {admission ? (
          <KV
            items={[
              [
                "Admission",
                <span className="mono" key="a">
                  {admission.admissionId ?? "—"}
                </span>
              ],
              ["Policy version", admission.policyVersion ?? "—"],
              [
                "Decision hash",
                <span className="hash" key="d">
                  {admission.policyDecisionHash ?? "—"}
                </span>
              ],
              [
                "Approval required",
                admission.requiresApproval === undefined ? "—" : admission.requiresApproval ? "Yes" : "No"
              ],
              ["Admitted by", admission.admittedByActorId ?? "—"],
              ["Admitted", formatTime(admission.admittedAt, { seconds: true })]
            ]}
          />
        ) : (
          <p className="muted">
            {plan ? "Plan drafted but NOT admitted: no admission is recorded for the current plan." : "Not admitted."}
          </p>
        )}
      </div>

      <div className="section">
        <h3 className="eyebrow">Attempts</h3>
        <DataTable
          caption={`Execution attempts for ${workItemId}`}
          rows={ordered}
          rowKey={(attempt) => attempt.attemptId}
          empty={
            <p className="muted" style={{ padding: "var(--space-3)" }}>
              No attempts yet.
            </p>
          }
          columns={[
            { id: "n", header: "#", cell: (a) => a.attemptNumber },
            {
              id: "id",
              header: "Attempt",
              cell: (a) => (
                <span className="mono" title={a.attemptId}>
                  {shortId(a.attemptId)}
                </span>
              )
            },
            { id: "status", header: "Status", cell: (a) => <Badge meta={attemptStatusMeta(a.status)} /> },
            { id: "worker", header: "Worker", cell: (a) => a.claimedByWorkerId ?? "—" },
            { id: "epoch", header: "Fencing epoch", cell: (a) => a.currentFencingEpoch },
            { id: "started", header: "Started", cell: (a) => formatTime(a.startedAt) },
            {
              id: "dur",
              header: "Duration",
              cell: (a) =>
                a.startedAt
                  ? formatDuration(
                      (["succeeded", "failed", "cancelled"].includes(a.status) ? Date.parse(a.updatedAt) : now) -
                        Date.parse(a.startedAt)
                    )
                  : "—"
            }
          ]}
        />
      </div>

      <div className="section">
        <h3 className="eyebrow">Leases (sanitized)</h3>
        <DataTable
          caption={`Attempt leases for ${workItemId}`}
          rows={[...leases].sort((a, b) => b.fencingEpoch - a.fencingEpoch)}
          rowKey={(lease) => lease.leaseId}
          empty={
            <p className="muted" style={{ padding: "var(--space-3)" }}>
              No leases recorded.
            </p>
          }
          columns={[
            {
              id: "id",
              header: "Lease",
              cell: (l) => (
                <span className="mono" title={l.leaseId}>
                  {shortId(l.leaseId)}
                </span>
              )
            },
            { id: "worker", header: "Worker", cell: (l) => l.workerId },
            { id: "status", header: "State", cell: (l) => <Badge meta={leaseStatusMeta(l.status)} /> },
            { id: "epoch", header: "Fencing epoch", cell: (l) => l.fencingEpoch },
            { id: "exp", header: "Expires", cell: (l) => formatTime(l.expiresAt, { seconds: true }) },
            {
              id: "left",
              header: "Remaining",
              cell: (l) => {
                const remaining = leaseRemainingMs(l, now);
                return remaining === undefined ? "—" : remaining < 0 ? "expired" : formatDuration(remaining);
              }
            },
            {
              id: "policy",
              header: "Policy",
              cell: (l) => (
                <span className="mono" title={l.policyDecisionHash}>
                  {l.policyVersion} · {shortHash(l.policyDecisionHash)}
                </span>
              )
            }
          ]}
        />
        <p className="hint">Lease tokens and token hashes are never sent to or shown by this console.</p>
      </div>

      <div className="section">
        <h3 className="eyebrow">Artifacts</h3>
        {artifacts.length === 0 ? (
          <p className="muted">No artifacts recorded for this work item.</p>
        ) : (
          <DataTable
            caption="Artifacts"
            rows={artifacts}
            rowKey={(artifact) => String(artifact.name)}
            columns={[
              { id: "n", header: "Name", cell: (a) => String(a.name ?? "—") },
              { id: "k", header: "Kind", cell: (a) => String(a.kind ?? a.mediaType ?? "—") },
              { id: "s", header: "Size", cell: (a) => (typeof a.sizeBytes === "number" ? `${a.sizeBytes} B` : "—") },
              {
                id: "h",
                header: "SHA-256",
                cell: (a) => <span className="mono">{typeof a.sha256 === "string" ? shortHash(a.sha256) : "—"}</span>
              }
            ]}
          />
        )}
      </div>

      <div className="section">
        <h3 className="eyebrow">Execution events</h3>
        <EventTimeline events={executionEvents} limit={30} />
      </div>

      {latest && (
        <div className="section">
          <h3 className="eyebrow">Current / latest attempt</h3>
          <KV
            items={[
              [
                "Attempt",
                <span className="mono" key="a">
                  {latest.attemptId}
                </span>
              ],
              [
                "Input hash",
                <span className="hash" key="i">
                  {latest.inputHash}
                </span>
              ],
              [
                "Plan hash",
                <span className="hash" key="p">
                  {latest.planHash}
                </span>
              ],
              ["Worker", latest.claimedByWorkerId ?? "unclaimed"],
              ["Lease", latestLease ? `${latestLease.status} · epoch ${latestLease.fencingEpoch}` : "no lease"],
              ["Retries", Math.max(0, attempts.length - 1)],
              ["Progress", "Not reported — the gateway records attempt status, not percent complete."]
            ]}
          />
        </div>
      )}
    </div>
  );
}
