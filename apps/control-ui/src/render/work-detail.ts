import { executionModeChipHtml, type ResultExecutionMode } from "../execution-mode.js";
import { nanoToIso, pill, time } from "../format.js";
import { escapeHtml } from "../html.js";
import { redactSecrets, redactedAttributesJson } from "../redaction.js";
import { workItemControlsHtml } from "../work-item-controls.js";

export interface WorkItemDetailView {
  id: string;
  title: string;
  status: string;
  risk: string;
  requester?: string;
  intent?: string;
  target?: unknown;
  createdAt?: string;
  requestedActions?: Array<{ kind: string; description?: string }>;
  /** Execution mode chip source: omitted (or `"none"`) when the item has no persisted result. */
  executionMode?: ResultExecutionMode | "none";
}

/** Markup for the work-item detail panel (axe smoke + client parity). */
export function renderWorkItemDetailHtml(
  workItem: WorkItemDetailView,
  events: Array<{ name?: string; timeUnixNano?: string; attributes?: Record<string, string> }> = []
): string {
  const actions = Array.isArray(workItem.requestedActions) ? workItem.requestedActions : [];
  const actionList = actions.length
    ? `<ul class="action-list">${actions
        .map(
          (action) =>
            `<li><strong>${escapeHtml(action.kind)}</strong><small>${escapeHtml(redactSecrets(action.description ?? ""))}</small></li>`
        )
        .join("")}</ul>`
    : `<p class="muted">No requested actions.</p>`;
  const eventItems = events.length
    ? `<ol class="detail-events">${events
        .slice(0, 8)
        .map((event) => {
          const attrs = event.attributes ?? {};
          const ref = attrs["work_item.id"] || attrs["agent.id"] || attrs["connector.id"] || "";
          const summary = workItemEventSummary(event.name ?? "", attrs, ref);
          const when = event.timeUnixNano ? time(nanoToIso(event.timeUnixNano)) : "—";
          return `<li><time>${when}</time><strong>${escapeHtml(event.name || "event")}</strong><small>${escapeHtml(redactSecrets(summary))}</small></li>`;
        })
        .join("")}</ol>`
    : `<p class="muted">No matching events.</p>`;
  return `<div class="detail-head"><div><h3 id="work-detail-title">${escapeHtml(workItem.title)}</h3><small>${escapeHtml(workItem.id)} · <a class="permalink" href="?item=${escapeHtml(encodeURIComponent(workItem.id))}#queue">Permalink</a></small></div><div>${pill(workItem.status)} ${pill(workItem.risk)}${executionModeChipHtml(workItem.executionMode)}</div></div><dl class="detail-grid"><div><dt>Requester</dt><dd>${escapeHtml(workItem.requester || "—")}</dd></div><div><dt>Intent</dt><dd>${escapeHtml(redactSecrets(workItem.intent || "—"))}</dd></div><div><dt>Target</dt><dd>${escapeHtml(workItem.target ? redactedAttributesJson(workItem.target) : "—")}</dd></div><div><dt>Created</dt><dd>${workItem.createdAt ? time(workItem.createdAt) : "—"}</dd></div></dl><div class="detail-section"><h4>Requested Actions</h4>${actionList}</div>${workItemControlsHtml(workItem)}<div class="detail-section"><h4>Timeline</h4>${eventItems}</div>`;
}

function workItemEventSummary(name: string, attributes: Record<string, string>, fallback: string): string {
  if (name === "agent.routing.candidate_evaluated") {
    const agentId = attributes["agent.id"] ?? "candidate";
    const score = attributes["routing.score"] ?? "—";
    const match = attributes["routing.match"] ?? "DEGRADED";
    const summary = match === "MATCH" ? "yes" : match === "NO_MATCH" ? "no" : "degraded";
    return `${agentId} · score ${score} · match ${summary}`;
  }
  if (name === "agent.routing.selected" || name === "work_item.worker_assigned") {
    const agentId = attributes["agent.id"] ?? "agent unavailable";
    const workerId = attributes["worker.id"] ?? "worker unavailable";
    return `${agentId} → ${workerId} · awaiting claim`;
  }
  if (name === "work_item.running") return "Worker claimed item; execution running";
  if (name === "execution_attempt.created") return "Execution attempt created; lease active";
  if (name === "agent.routing.no_match") return "No candidate met the semantic threshold";
  if (name === "agent.routing.no_eligible_agents") return "No eligible agent has a dispatchable worker path";
  if (name === "agent.routing.degraded") return "Nimble unavailable or response invalid; item remains retryable";
  if (name === "agent.routing.assignment_failed") return "Selected route could not be assigned";
  return fallback;
}
