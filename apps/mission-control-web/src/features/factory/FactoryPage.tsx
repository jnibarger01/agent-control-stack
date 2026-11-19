import type { FactoryBacklogReadModel, FactoryMissionViewModel } from "@agent-control-stack/mission-control-contract";
import { Card, DataTable, EmptyState, IdChip, StatusPill, type Tone } from "../../design/primitives";

const STAGE: Record<FactoryMissionViewModel["stage"], { label: string; tone: Tone }> = {
  awaiting_plan: { label: "Awaiting plan", tone: "neutral" },
  plan_review: { label: "Plan review", tone: "warn" },
  pending_dispatch: { label: "Pending dispatch", tone: "info" },
  executing: { label: "Executing", tone: "info" },
  needs_reconciliation: { label: "Needs reconciliation", tone: "bad" },
  blocked_integration: { label: "Blocked integration", tone: "bad" },
  failed_gate: { label: "Failed gate", tone: "bad" },
  verified_awaiting_publication: { label: "Verified, awaiting publication", tone: "accent" },
  publication_uncertain: { label: "Publication uncertain", tone: "bad" },
  draft_published: { label: "Draft published", tone: "ok" },
  cancelled: { label: "Cancelled", tone: "neutral" },
  unknown: { label: "Unknown", tone: "unknown" }
};

function budget(view: FactoryMissionViewModel): string {
  if (!view.budget) return "No budget recorded";
  const lanes = view.budget.limits.parallel_work_units;
  const wall = view.budget.limits.wall_clock_ms;
  return [lanes !== undefined ? `${lanes} parallel` : null, wall !== undefined ? `${Math.round(wall / 60_000)} min wall clock` : null]
    .filter(Boolean)
    .join(" · ") || "Budget recorded";
}

/** Factory backlog. Renders only contract-validated fields; the next action is a recommendation, never an authorization. */
export function FactoryPage({ data }: { data: FactoryBacklogReadModel }) {
  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-lg font-semibold">AI Factory</h1>
        <p className="text-sm text-muted">
          Missions you admitted. Stages come from recorded ACS state only. Recommendations are advisory: ACS still enforces every lease,
          budget, verification and approval.
        </p>
      </header>
      <Card title="Backlog">
        {data.missions.length === 0 ? (
          <EmptyState title="No factory missions">Preview and admit an order to start one.</EmptyState>
        ) : (
          <DataTable
            caption="AI Factory backlog"
            rowKey={(row) => row.missionId}
            rows={data.missions}
            columns={[
              { key: "mission", header: "Mission", render: (row) => <IdChip id={row.missionId} /> },
              {
                key: "base",
                header: "Pinned base",
                render: (row) => (
                  <span>
                    <span className="block">{row.repository}</span>
                    <code className="text-xs">{row.pinnedBaseSha.slice(0, 12)}</code>
                  </span>
                )
              },
              { key: "stage", header: "Stage", render: (row) => <StatusPill tone={STAGE[row.stage].tone}>{STAGE[row.stage].label}</StatusPill> },
              { key: "budget", header: "Budget", render: budget },
              { key: "gate", header: "Failed gate", render: (row) => row.failedGate ?? "None" },
              {
                key: "next",
                header: "Recommended next step",
                render: (row) => (
                  <span>
                    <span className="block">{row.nextAction.recommendation}</span>
                    <span className="text-xs text-muted">
                      Recommendation only{row.nextAction.requiresHumanApproval ? " · needs a human decision" : ""}
                    </span>
                  </span>
                )
              },
              {
                key: "evidence",
                header: "Evidence",
                render: (row) => (
                  <span>
                    {row.units.filter((unit) => unit.resultHash).length}/{row.units.length} units verified
                    {row.publication.state === "published" && row.publication.url ? (
                      <a className="block underline" href={row.publication.url} rel="noreferrer noopener" target="_blank">
                        Draft pull request
                      </a>
                    ) : row.publication.state === "uncertain" ? (
                      <span className="block">Publication uncertain</span>
                    ) : null}
                  </span>
                )
              }
            ]}
          />
        )}
      </Card>
    </div>
  );
}
