/**
 * Visibility panels: policy decision summary (#18), live operator metrics
 * (#19), and the theme switcher plus readable audit rows (#20).
 */
import type { StoredAuditEvent } from "@agent-control-stack/work-items";
import { escapeHtml } from "./html.js";
import { redactAttributes } from "./redaction.js";

// ---------------------------------------------------------------- #18 policy

type Decision = "allow" | "require_approval" | "deny";
const DECISIONS: readonly Decision[] = ["allow", "require_approval", "deny"];

export interface PolicyDecisionSummary {
  total: number;
  byDecision: Record<Decision, number>;
  byKind: Array<{ kind: string } & Record<Decision, number>>;
  topRules: Array<{ rule: string; count: number }>;
  recentDenials: Array<{ timeUnixNano: string; workItemId: string; kind: string; reason: string }>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Aggregates `policy.decided` events (any order). Other events are ignored. */
export function summarizePolicyDecisions(events: readonly StoredAuditEvent[]): PolicyDecisionSummary {
  const byDecision: Record<Decision, number> = { allow: 0, require_approval: 0, deny: 0 };
  const byKind = new Map<string, Record<Decision, number>>();
  const rules = new Map<string, number>();
  const denials: PolicyDecisionSummary["recentDenials"] = [];
  const decided = events
    .filter((event) => event.name === "policy.decided")
    .sort((left, right) => (right.sequence ?? 0) - (left.sequence ?? 0));
  for (const event of decided) {
    const body = asRecord((event as unknown as { body?: unknown }).body);
    const attributes = asRecord(event.attributes);
    const decision = (body.decision ?? attributes["policy.decision"]) as Decision;
    if (!DECISIONS.includes(decision)) continue;
    byDecision[decision] += 1;
    const kind = String(asRecord(asRecord(body.context).action).kind ?? "unknown");
    const row = byKind.get(kind) ?? { allow: 0, require_approval: 0, deny: 0 };
    row[decision] += 1;
    byKind.set(kind, row);
    for (const rule of Array.isArray(body.matchedRules) ? body.matchedRules : []) {
      rules.set(String(rule), (rules.get(String(rule)) ?? 0) + 1);
    }
    if (decision === "deny" && denials.length < 5) {
      denials.push({
        timeUnixNano: event.timeUnixNano,
        workItemId: String(body.workItemId ?? attributes["work_item.id"] ?? ""),
        kind,
        reason: String(body.reason ?? "")
      });
    }
  }
  return {
    total: byDecision.allow + byDecision.require_approval + byDecision.deny,
    byDecision,
    byKind: [...byKind.entries()]
      .map(([kind, counts]) => ({ kind, ...counts }))
      .sort(
        (left, right) =>
          right.deny - left.deny ||
          right.require_approval - left.require_approval ||
          left.kind.localeCompare(right.kind)
      ),
    topRules: [...rules.entries()]
      .map(([rule, count]) => ({ rule, count }))
      .sort((left, right) => right.count - left.count || left.rule.localeCompare(right.rule))
      .slice(0, 8),
    recentDenials: denials
  };
}

export function policyPanelHtml(
  summary: PolicyDecisionSummary,
  supportedKinds: readonly string[],
  formatTime: (timeUnixNano: string) => string
): string {
  const kinds = supportedKinds.length
    ? `<div class="detail-section"><h4>Action kinds policy evaluates</h4><div class="chip-list">${supportedKinds.map((kind) => `<span class="chip">${escapeHtml(kind)}</span>`).join("")}</div><p class="muted">Any other kind is denied (fail closed).</p></div>`
    : "";
  if (!summary.total) {
    return `<p class="empty">No policy decisions in the recent window.</p>${kinds}`;
  }
  const counts = `<dl class="policy-counts"><div class="decision-allow"><dt>Allowed</dt><dd>${summary.byDecision.allow}</dd></div><div class="decision-require_approval"><dt>Needed approval</dt><dd>${summary.byDecision.require_approval}</dd></div><div class="decision-deny"><dt>Denied</dt><dd>${summary.byDecision.deny}</dd></div></dl><p class="muted">Last ${summary.total} decisions.</p>`;
  const table = `<div class="table-wrap"><table class="policy-kinds"><thead><tr><th scope="col">Action kind</th><th scope="col">Allow</th><th scope="col">Approval</th><th scope="col">Deny</th></tr></thead><tbody>${summary.byKind
    .map(
      (row) =>
        `<tr><td><code>${escapeHtml(row.kind)}</code></td><td>${row.allow}</td><td>${row.require_approval}</td><td>${row.deny}</td></tr>`
    )
    .join("")}</tbody></table></div>`;
  const rules = summary.topRules.length
    ? `<div class="detail-section"><h4>Most matched rules</h4><ol class="rule-list">${summary.topRules.map((rule) => `<li><code>${escapeHtml(rule.rule)}</code> <small>${rule.count}</small></li>`).join("")}</ol></div>`
    : "";
  const denials = summary.recentDenials.length
    ? `<div class="detail-section"><h4>Recent denials</h4><ol class="detail-events">${summary.recentDenials
        .map(
          (denial) =>
            `<li><time>${formatTime(denial.timeUnixNano)}</time><strong><code>${escapeHtml(denial.kind)}</code> ${escapeHtml(denial.workItemId)}</strong><small>${escapeHtml(denial.reason)}</small></li>`
        )
        .join("")}</ol></div>`
    : "";
  return `${counts}${table}${rules}${denials}${kinds}`;
}

// ---------------------------------------------------------- #20 audit rows

/** Attribute keys worth surfacing on the collapsed audit row, in priority order. */
export const AUDIT_SUMMARY_KEYS = [
  "work_item.id",
  "work_item.status",
  "policy.decision",
  "agent.id",
  "worker.id",
  "connector.id",
  "action.kind"
] as const;

function displayValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** Summary line and expandable key/value list for one audit event (attributes redacted). */
export function auditAttributesHtml(attributes: unknown): string {
  const redacted = asRecord(redactAttributes(attributes ?? {}));
  const keys = Object.keys(redacted);
  if (!keys.length) return `<small class="event-summary">no attributes</small>`;
  const preferred = AUDIT_SUMMARY_KEYS.filter((key) => key in redacted);
  const summaryKeys = (preferred.length ? preferred : keys).slice(0, 3);
  const summary = summaryKeys.map((key) => `${key}=${displayValue(redacted[key])}`).join(" · ");
  const rows = keys
    .map((key) => `<div><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(displayValue(redacted[key]))}</dd></div>`)
    .join("");
  return `<small class="event-summary">${escapeHtml(summary)}</small><details class="event-attrs"><summary>${keys.length} attribute${keys.length === 1 ? "" : "s"}</summary><dl>${rows}</dl></details>`;
}

function scriptSafeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/** Client twin of `auditAttributesHtml`. Relies on `redactAttributesClient` and `escapeClient`. */
export function auditRowsClientSource(): string {
  return `
const auditSummaryKeys = ${scriptSafeJson(AUDIT_SUMMARY_KEYS)};
function auditDisplayValue(value) {
  return typeof value === 'string' ? value : JSON.stringify(value);
}
function auditAttributesMarkup(attributes) {
  const raw = redactAttributesClient(attributes || {});
  const redacted = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const keys = Object.keys(redacted);
  if (!keys.length) return '<small class="event-summary">no attributes</small>';
  const preferred = auditSummaryKeys.filter(function (key) { return key in redacted; });
  const summaryKeys = (preferred.length ? preferred : keys).slice(0, 3);
  const summary = summaryKeys.map(function (key) { return key + '=' + auditDisplayValue(redacted[key]); }).join(' · ');
  const rows = keys.map(function (key) { return '<div><dt>' + escapeClient(key) + '</dt><dd>' + escapeClient(auditDisplayValue(redacted[key])) + '</dd></div>'; }).join('');
  return '<small class="event-summary">' + escapeClient(summary) + '</small><details class="event-attrs"><summary>' + keys.length + ' attribute' + (keys.length === 1 ? '' : 's') + '</summary><dl>' + rows + '</dl></details>';
}
`;
}

// -------------------------------------------------------------- #19 metrics

export const METRICS_POLL_MS = 15_000;
export const METRICS_HISTORY = 20;

export const METRIC_ROWS = [
  { key: "http429", label: "HTTP 429 responses", bad: true },
  { key: "rateLimited", label: "Rate-limit rejections", bad: true },
  { key: "http5xx", label: "HTTP 5xx responses", bad: true },
  { key: "authLockouts", label: "Auth lockouts", bad: true },
  { key: "sseRejected", label: "SSE connections refused", bad: true },
  { key: "sseDropped", label: "SSE clients dropped", bad: true },
  { key: "httpRequests", label: "HTTP requests", bad: false },
  { key: "auditEvents", label: "Audit events", bad: false }
] as const;

/** Relies on the dashboard client's `fetchJson`, `announce`, and `escapeClient`. */
export function metricsClientSource(): string {
  return `
const metricRows = ${scriptSafeJson(METRIC_ROWS)};
const metricSamples = [];
let metricsTimer = null;
let metricsInFlight = false;
const trendBars = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

function metricTrend(key) {
  const deltas = [];
  for (let i = 1; i < metricSamples.length; i += 1) {
    deltas.push(Math.max(0, Number(metricSamples[i].metrics[key] || 0) - Number(metricSamples[i - 1].metrics[key] || 0)));
  }
  if (!deltas.length) return '';
  const max = Math.max.apply(null, deltas);
  return deltas.map(function (delta) { return max === 0 ? trendBars[0] : trendBars[Math.min(7, Math.round((delta / max) * 7))]; }).join('');
}

function renderLiveMetrics() {
  const root = document.getElementById('live-metrics');
  if (!root || !metricSamples.length) return;
  const latest = metricSamples[metricSamples.length - 1];
  const previous = metricSamples.length > 1 ? metricSamples[metricSamples.length - 2] : null;
  const rows = metricRows.map(function (row) {
    const total = Number(latest.metrics[row.key] || 0);
    const delta = previous ? Math.max(0, total - Number(previous.metrics[row.key] || 0)) : null;
    const hot = row.bad && delta !== null && delta > 0;
    return '<tr class="' + (hot ? 'metric-hot' : '') + '"><th scope="row">' + escapeClient(row.label) + '</th><td>' + total + '</td><td>' + (delta === null ? '—' : '+' + delta) + '</td><td class="metric-trend" aria-hidden="true">' + metricTrend(row.key) + '</td></tr>';
  }).join('');
  root.innerHTML = '<table class="metrics-table"><thead><tr><th scope="col">Since gateway start</th><th scope="col">Total</th><th scope="col">Δ last poll</th><th scope="col">Trend</th></tr></thead><tbody>' + rows + '</tbody></table>' +
    '<p class="muted">SQLite ' + (latest.metrics.sqliteReady ? 'ready' : 'NOT ready') + ' · polled ' + new Date(latest.at).toLocaleTimeString() + ' every ${METRICS_POLL_MS / 1000}s while this view is open.</p>';
}

async function pollMetrics() {
  if (metricsInFlight) return;
  metricsInFlight = true;
  try {
    const body = await fetchJson('/dashboard/metrics');
    if (body && body.metrics) {
      const previous = metricSamples[metricSamples.length - 1];
      metricSamples.push({ at: body.at || new Date().toISOString(), metrics: body.metrics });
      while (metricSamples.length > ${METRICS_HISTORY}) metricSamples.shift();
      if (previous && previous.metrics.sqliteReady && !body.metrics.sqliteReady) announce('SQLite control plane is not ready');
      renderLiveMetrics();
    }
  } catch (error) {
    const root = document.getElementById('live-metrics');
    if (root && !metricSamples.length) root.innerHTML = '<p class="muted">Metrics unavailable.</p>';
  } finally {
    metricsInFlight = false;
  }
}

function syncMetricsPolling() {
  const active = document.body.dataset.activeView === 'metrics' && document.visibilityState !== 'hidden';
  if (active && !metricsTimer) {
    void pollMetrics();
    metricsTimer = setInterval(function () { void pollMetrics(); }, ${METRICS_POLL_MS});
  } else if (!active && metricsTimer) {
    clearInterval(metricsTimer);
    metricsTimer = null;
  }
}
document.addEventListener('visibilitychange', syncMetricsPolling);
`;
}

// ---------------------------------------------------------------- #20 theme

export const THEME_STORAGE_KEY = "acs.mc.theme";
export const THEME_CHOICES = ["auto", "light", "dark"] as const;

/** Runs in <head> so a saved theme applies before first paint. */
export function themeBootScript(): string {
  return `try{var t=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});if(t==="light"||t==="dark")document.documentElement.dataset.theme=t;}catch(e){}`;
}

/** Relies on the dashboard client's `announce`. */
export function themeClientSource(): string {
  return `
const themeChoices = ${scriptSafeJson(THEME_CHOICES)};
function currentThemeChoice() {
  const value = document.documentElement.dataset.theme;
  return value === 'light' || value === 'dark' ? value : 'auto';
}
function renderThemeToggle() {
  const toggle = document.getElementById('theme-toggle');
  if (!toggle) return;
  const choice = currentThemeChoice();
  toggle.textContent = 'Theme: ' + choice;
  toggle.setAttribute('aria-label', 'Theme: ' + choice + '. Activate to switch.');
}
function setThemeChoice(choice) {
  if (choice === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = choice;
  try {
    if (choice === 'auto') localStorage.removeItem(${JSON.stringify(THEME_STORAGE_KEY)});
    else localStorage.setItem(${JSON.stringify(THEME_STORAGE_KEY)}, choice);
  } catch {}
  renderThemeToggle();
  announce('Theme: ' + choice);
}
document.getElementById('theme-toggle')?.addEventListener('click', function () {
  const next = themeChoices[(themeChoices.indexOf(currentThemeChoice()) + 1) % themeChoices.length];
  setThemeChoice(next);
});
renderThemeToggle();
`;
}
