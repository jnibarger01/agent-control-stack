import { type WorkItem } from "@agent-control-stack/work-items";
import { projectAgents } from "../agents.js";
import { nanoToIso, time } from "../format.js";
import { type DashboardFragments } from "../live-dashboard.js";
import { DEFAULT_APPROVAL_SLA_MS, sortApprovalItems } from "../operator-workflow.js";
import { type MissionControlAgent, type MissionControlViewModel } from "../types.js";
import { policyPanelHtml, summarizePolicyDecisions } from "../visibility.js";
import {
  approvalOptionsByWorkItem,
  approvalsPanel,
  connectorsPanel,
  eventTimeline,
  humanInterruptsPanel,
  operatorMetricsPanel,
  overviewCards,
  queueFooter,
  summarize,
  systemStats,
  toCount,
  workQueueItems
} from "./panels.js";

export function dashboardModel(input: WorkItem[] | MissionControlViewModel): MissionControlViewModel {
  return Array.isArray(input) ? { workItems: input, events: [] } : input;
}

export function dashboardAgents(model: MissionControlViewModel): MissionControlAgent[] {
  return (
    model.agents ??
    projectAgents(model.workItems, model.events ?? [], model.now ?? new Date(), model.registeredAgents ?? [])
  );
}

/**
 * Markup for every live-updated dashboard section. The page embeds these at
 * render time and `GET /dashboard/fragments` returns them for in-place patches,
 * so there is exactly one renderer for each section.
 */
export function renderDashboardFragments(
  input: WorkItem[] | MissionControlViewModel,
  agents: MissionControlAgent[] = dashboardAgents(dashboardModel(input))
): DashboardFragments {
  const model = dashboardModel(input);
  const now = model.now ?? new Date();
  const stats = summarize(model.workItems, agents, model.statusCounts);
  const approvalItems = model.workItems.filter((item) => item.status === "needs_approval" || item.status === "blocked");
  const attemptLeasesByWorkItem = model.attemptLeasesByWorkItem ?? {};
  // One SLA source for the whole render: the per-card badges, the approvals
  // panel, and the metrics-panel breach count must always agree.
  const approvalSlaMs = model.approvalSlaMs === undefined ? DEFAULT_APPROVAL_SLA_MS : toCount(model.approvalSlaMs);
  return {
    cards: overviewCards(stats),
    queueList: workQueueItems(
      model.workItems,
      model.executionPlansByWorkItem ?? {},
      model.executionPlanAdmissionsByWorkItem ?? {},
      model.executionAttemptsByWorkItem ?? {},
      attemptLeasesByWorkItem
    ),
    queueFooter: queueFooter(model.finishedWorkItems),
    approvalsList:
      humanInterruptsPanel(model.humanInterrupts ?? []) +
      approvalsPanel(sortApprovalItems(approvalItems, now), approvalOptionsByWorkItem(model), now, approvalSlaMs),
    approvalsCount: `${approvalItems.length + (model.humanInterrupts?.length ?? 0)} waiting`,
    metrics: operatorMetricsPanel(model.workItems, attemptLeasesByWorkItem, now, approvalSlaMs),
    systemStats: systemStats(stats, model.executionBackend),
    policy: policyPanelHtml(
      summarizePolicyDecisions(model.policyDecisionEvents ?? model.events ?? []),
      model.composerActionKinds ?? [],
      (timeUnixNano) => time(nanoToIso(timeUnixNano))
    ),
    eventsTimeline: eventTimeline([...(model.events ?? [])].reverse()),
    connectors: connectorsPanel(agents, model.executionBackend),
    generatedAt: now.toISOString()
  };
}
