// Public surface of the Mission Control renderer. Implementation lives in the
// modules below; this file only re-exports so callers keep one import path.
export { projectAgents } from "./agents.js";
export {
  isElevatedApprovalRisk,
  approvalActionHashPrefix,
  type ApprovalConfirmRequest,
  type ApprovalConfirmDocument,
  requestApprovalConfirm,
  type ApprovalPostResult,
  type ApprovalActionClickOptions,
  handleApprovalActionClick
} from "./approval-actions.js";
export {
  WORK_ITEM_STATUS_VALUES,
  type QueueFilter,
  emptyQueueFilter,
  isQueueFilterEmpty,
  workItemAgentId,
  parseQueueFilter,
  serializeQueueFilter,
  type QueueFilterableItem,
  filterWorkItems,
  type QueueFilterDomRoot,
  type QueueFilterDomElement,
  applyQueueFilterToDom
} from "./queue-filter.js";
export { renderDashboardFragments } from "./render/fragments.js";
export { renderDashboard } from "./render/page.js";
export { type WorkItemDetailView, renderWorkItemDetailHtml } from "./render/work-detail.js";
export {
  type SseConnectionRoot,
  type SseConnectionElement,
  type SseConnectionButton,
  nextSseReconnectDelayMs,
  applySseConnectionState
} from "./sse-connection.js";
export {
  type MissionControlAgent,
  type MissionControlAttemptLease,
  toMissionControlAttemptLease,
  type MissionControlViewModel,
  type ApprovalActionOption
} from "./types.js";

export {
  isSecretAttributeKey,
  redactAttributes,
  redactedAttributesJson,
  redactSecrets,
  SECRET_KEY_PATTERN,
  SECRET_VALUE_PATTERNS
} from "./redaction.js";
export {
  REASON_REQUIRED_CONTROLS,
  WORK_ITEM_CONTROL_STATUSES,
  WORK_ITEM_CONTROLS,
  workItemControlsFor,
  workItemControlsHtml,
  type WorkItemControl
} from "./work-item-controls.js";
export {
  AGENT_REFRESH_DEBOUNCE_MS,
  DASHBOARD_CATCH_UP_TARGETS,
  DASHBOARD_FRAGMENT_TARGETS,
  MAX_REFRESH_RETRY_MS,
  MIN_REFRESH_INTERVAL_MS,
  PERIODIC_REFRESH_MS,
  WORK_EVENT_PREFIXES,
  WORK_ITEM_REFRESH_DEBOUNCE_MS,
  type DashboardFragmentName,
  type DashboardFragments
} from "./live-dashboard.js";
export { LIVE_TIMELINE_CAP, OLDER_EVENTS_PAGE } from "./audit-timeline.js";
export { COMPOSER_PREVIEW_DEBOUNCE_MS, composerHtml, DEFAULT_ACTION_KIND } from "./composer.js";
export {
  AUDIT_SUMMARY_KEYS,
  auditAttributesHtml,
  METRIC_ROWS,
  METRICS_HISTORY,
  METRICS_POLL_MS,
  policyPanelHtml,
  summarizePolicyDecisions,
  THEME_CHOICES,
  THEME_STORAGE_KEY,
  type PolicyDecisionSummary
} from "./visibility.js";
export { PROBE_HISTORY, PROBE_INTERVAL_MS, PROBE_PATH, PROBE_SLOW_MS } from "./system-probes.js";
export {
  approvalWaitMs,
  approvalWaitStart,
  DEFAULT_APPROVAL_SLA_MS,
  formatWait,
  KEYBOARD_SHORTCUTS,
  sortApprovalItems
} from "./operator-workflow.js";
