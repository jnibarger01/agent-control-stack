export function styles(): string {
  return `
:root {
  color-scheme: dark;
  font-family: Inter, ui-sans-serif, system-ui, sans-serif;
  --bg: #0e1116;
  --surface: #171b22;
  --surface-2: #1e242e;
  --ink: #e8edf4;
  --muted: #8b97a8;
  --muted-strong: #a9b6c7;
  --line: #2a3342;
  --soft-line: #222a36;
  --side: #10141a;
  --side-line: #252a30;
  --side-muted: #8b97a8;
  --brand: #f8fafc;
  --nav-ink: #c1c8d0;
  --nav-active: #243044;
  --nav-active-ink: #ffffff;
  --accent: #3b82f6;
  --primary: #2563eb;
  --primary-ink: #ffffff;
  --green: #3ddc97;
  --amber: #f5b942;
  --red: #ff6b6b;
  --hover: #243044;
  --control-bg: #171b22;
  --control-line: #334052;
  --control-hover-line: #4b6180;
  --banner-bg: #2a2416;
  --banner-line: #6b5420;
  --admin-banner-line: #ffb020;
  --admin-banner-bg: #3a2508;
  --admin-banner-ink: #ffd27a;
  --attention-bg: #2a1c1c;
  --pill-bg: #1e242e;
  --pill-ink: #b4bfcd;
  --pill-line: #334052;
  --ok-bg: #13261e;
  --ok-line: #24553f;
  --warn-bg: #2a2416;
  --warn-line: #6b5420;
  --bad-bg: #2c1a1a;
  --bad-line: #6b2f2f;
  --overlay: rgba(4, 6, 9, .6);
  --shadow: rgba(0, 0, 0, .25);
  background: var(--bg);
  color: var(--ink);
}
/* Light theme: follows the OS unless the operator picked a theme. */
@media (prefers-color-scheme: light) {
  :root:not([data-theme="dark"]) {
  color-scheme: light;
  --bg: #f5f7fa;
  --surface: #ffffff;
  --surface-2: #f1f4f8;
  --ink: #17202a;
  --muted: #5b6778;
  --muted-strong: #43536a;
  --line: #d9e1ea;
  --soft-line: #edf1f5;
  --side: #eef2f6;
  --side-line: #d9e1ea;
  --side-muted: #5b6778;
  --brand: #0f172a;
  --nav-ink: #334155;
  --nav-active: #dde6f2;
  --nav-active-ink: #0f172a;
  --accent: #2563eb;
  --primary: #2563eb;
  --primary-ink: #ffffff;
  --green: #15803d;
  --amber: #b45309;
  --red: #b91c1c;
  --hover: #f4f8ff;
  --control-bg: #ffffff;
  --control-line: #cbd5e1;
  --control-hover-line: #9db7d7;
  --banner-bg: #fff8e6;
  --banner-line: #f1d18a;
  --admin-banner-line: #b7791f;
  --admin-banner-bg: #fff4e0;
  --admin-banner-ink: #7a4a00;
  --attention-bg: #fff8f7;
  --pill-bg: #eef2f6;
  --pill-ink: #45515f;
  --pill-line: #d7dfe8;
  --ok-bg: #eef9f2;
  --ok-line: #a8d8bd;
  --warn-bg: #fff8e6;
  --warn-line: #f1d18a;
  --bad-bg: #fff1ef;
  --bad-line: #f0b8b2;
  --overlay: rgba(17, 20, 23, .45);
  --shadow: rgba(23, 32, 42, .08);
  }
}
:root[data-theme="light"] {
  color-scheme: light;
  --bg: #f5f7fa;
  --surface: #ffffff;
  --surface-2: #f1f4f8;
  --ink: #17202a;
  --muted: #5b6778;
  --muted-strong: #43536a;
  --line: #d9e1ea;
  --soft-line: #edf1f5;
  --side: #eef2f6;
  --side-line: #d9e1ea;
  --side-muted: #5b6778;
  --brand: #0f172a;
  --nav-ink: #334155;
  --nav-active: #dde6f2;
  --nav-active-ink: #0f172a;
  --accent: #2563eb;
  --primary: #2563eb;
  --primary-ink: #ffffff;
  --green: #15803d;
  --amber: #b45309;
  --red: #b91c1c;
  --hover: #f4f8ff;
  --control-bg: #ffffff;
  --control-line: #cbd5e1;
  --control-hover-line: #9db7d7;
  --banner-bg: #fff8e6;
  --banner-line: #f1d18a;
  --admin-banner-line: #b7791f;
  --admin-banner-bg: #fff4e0;
  --admin-banner-ink: #7a4a00;
  --attention-bg: #fff8f7;
  --pill-bg: #eef2f6;
  --pill-ink: #45515f;
  --pill-line: #d7dfe8;
  --ok-bg: #eef9f2;
  --ok-line: #a8d8bd;
  --warn-bg: #fff8e6;
  --warn-line: #f1d18a;
  --bad-bg: #fff1ef;
  --bad-line: #f0b8b2;
  --overlay: rgba(17, 20, 23, .45);
  --shadow: rgba(23, 32, 42, .08);
}
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; background: var(--bg); display: grid; grid-template-columns: 216px minmax(0, 1fr); }
aside { border-right: 1px solid var(--side-line); padding: 22px 16px; background: var(--side); position: sticky; top: 0; height: 100vh; }
.brand { color: var(--brand); font-size: 20px; font-weight: 800; }
.brand span { display: block; color: var(--side-muted); font-size: 11px; margin-top: 4px; font-weight: 700; }
nav { display: grid; gap: 4px; margin-top: 30px; }
nav a { color: var(--nav-ink); text-decoration: none; padding: 10px 12px; border-radius: 8px; }
nav a.active, nav a:hover { background: var(--nav-active); color: var(--nav-active-ink); }
.rail-note { color: var(--side-muted); font-size: 12px; line-height: 1.45; position: absolute; bottom: 24px; left: 16px; right: 16px; }
main { padding: 22px 24px 40px; min-width: 0; }
header { display: flex; justify-content: space-between; align-items: start; gap: 16px; margin-bottom: 18px; }
h1 { margin: 0; font-size: 26px; color: var(--ink); }
p { color: var(--muted); margin: 6px 0 0; }
.live { border: 1px solid var(--line); border-radius: 999px; padding: 8px 12px; color: var(--muted); background: var(--surface); white-space: nowrap; }
.live > span[aria-hidden="true"] { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--green); margin-right: 8px; }
.live.disconnected > span[aria-hidden="true"] { background: var(--red); }
.live.connecting > span[aria-hidden="true"] { background: var(--muted); }
.header-status { display: grid; justify-items: end; gap: 4px; }
.dashboard-updated { color: var(--muted); font-size: 11px; min-height: 1em; }
.wait-badge { color: var(--muted); font-size: 11px; margin-left: 4px; }
.approval-item.overdue { border-color: var(--amber); box-shadow: inset 3px 0 0 var(--amber); }
.approval-item.overdue .wait-badge { color: var(--amber); font-weight: 600; }
.approval-item[data-risk="critical"] { box-shadow: inset 3px 0 0 var(--red); }
.approval-item[data-risk="critical"].overdue { box-shadow: inset 3px 0 0 var(--red), inset 6px 0 0 var(--amber); }
kbd { font: 11px ui-monospace, SFMono-Regular, Menlo, monospace; border: 1px solid var(--line); border-bottom-width: 2px; border-radius: 4px; padding: 1px 5px; background: var(--surface); color: var(--ink); }
.shortcut-list { display: grid; gap: 6px; margin: 12px 0; }
.shortcut-list div { display: grid; grid-template-columns: 72px 1fr; gap: 10px; align-items: center; }
.shortcut-list dt, .shortcut-list dd { margin: 0; }
#shortcut-help[hidden] { display: none; }
.permalink { color: var(--accent); }
.header-tools { display: flex; gap: 6px; }
.event-summary { display: block; color: var(--muted); overflow-wrap: anywhere; }
.event-attrs summary { cursor: pointer; color: var(--accent); font-size: 11px; margin-top: 2px; }
.event-attrs dl { display: grid; gap: 2px; margin: 4px 0 0; font-size: 12px; }
.event-attrs dl div { display: grid; grid-template-columns: minmax(90px, 38%) 1fr; gap: 8px; }
.event-attrs dt { color: var(--muted); overflow-wrap: anywhere; }
.event-attrs dd { margin: 0; overflow-wrap: anywhere; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.policy-body { padding: 12px 16px 16px; display: grid; gap: 10px; }
.policy-counts { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin: 0; }
.policy-counts div { border: 1px solid var(--line); border-radius: 8px; padding: 8px; }
.policy-counts dt { color: var(--muted); font-size: 11px; }
.policy-counts dd { margin: 2px 0 0; font-size: 20px; font-weight: 700; }
.policy-counts .decision-allow dd { color: var(--green); }
.policy-counts .decision-require_approval dd { color: var(--amber); }
.policy-counts .decision-deny dd { color: var(--red); }
.rule-list { margin: 0; padding-left: 18px; font-size: 12px; }
.live-metrics { padding: 0 16px; }
.metrics-table th[scope="row"] { font-weight: 500; color: var(--ink); text-transform: none; font-size: 13px; }
.metrics-table tr.metric-hot th, .metrics-table tr.metric-hot td { color: var(--amber); }
.metric-trend { letter-spacing: 1px; color: var(--accent); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.queue-footer { display: grid; gap: 6px; margin-top: 8px; }
.queue-footer-note { margin: 0; color: var(--muted); font-size: 12px; }
.load-more, .tool-button { justify-self: start; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); color: var(--ink); padding: 6px 10px; cursor: pointer; font: inherit; font-size: 12px; }
.load-more:disabled, .tool-button:disabled { opacity: .55; cursor: not-allowed; }
.tool-button[aria-pressed="true"] { border-color: var(--amber); color: var(--amber); }
.panel-tools { display: inline-flex; gap: 8px; align-items: center; }
#events-load-older { margin-top: 10px; }
.probe-trend { margin: 6px 0 0; letter-spacing: 2px; color: var(--green); }
#system-probes[data-state="slow"] dd, #system-probes[data-state="failing"] dd, #system-probes[data-state="down"] dd { color: var(--amber); }
#system-probes[data-state="down"] .probe-trend, #system-probes[data-state="failing"] .probe-trend { color: var(--red); }
.action-status { margin: 0 0 10px; min-height: 1.25em; color: var(--muted); font-size: 13px; }
.stale-banner { margin-bottom: 14px; padding: 10px 14px; border: 1px solid var(--banner-line); background: var(--banner-bg); color: var(--amber); border-radius: 8px; font-weight: 600; }
.stale-banner[hidden] { display: none; }
.header-controls { display: flex; gap: 12px; align-items: start; }
.execution-mode { border: 1px solid var(--line); border-radius: 8px; padding: 8px 12px; background: var(--surface); }
.execution-mode legend { font-size: 12px; font-weight: 700; padding: 0 4px; }
.execution-mode label { display: block; margin-top: 4px; }
.admin-mode-banner { margin: 0 0 14px; padding: 12px 14px; border: 2px solid var(--admin-banner-line); background: var(--admin-banner-bg); color: var(--admin-banner-ink); border-radius: 8px; font-weight: 800; letter-spacing: .02em; }
.admin-mode-banner[hidden] { display: none; }
.cards { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 12px; margin-bottom: 14px; }
.card, .panel { border: 1px solid var(--line); background: var(--surface); border-radius: 8px; box-shadow: 0 10px 24px var(--shadow); }
.card { padding: 15px; min-height: 108px; }
.card span, .panel-head span { color: var(--muted); font-size: 12px; text-transform: uppercase; }
.card strong { display: block; font-size: 30px; margin-top: 10px; color: var(--ink); }
.card p { font-size: 12px; line-height: 1.35; }
.grid { display: grid; grid-template-columns: minmax(0, 2fr) minmax(320px, .85fr); gap: 14px; margin-bottom: 14px; }
.lower { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.panel { min-width: 0; overflow: hidden; }
.panel-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 14px 16px; border-bottom: 1px solid var(--line); background: var(--surface); }
.panel-head p { font-size: 12px; margin-top: 3px; }
h2 { margin: 0; font-size: 16px; color: var(--ink); }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 11px 12px; border-bottom: 1px solid var(--soft-line); vertical-align: top; font-size: 13px; }
th { color: var(--muted); font-size: 11px; text-transform: uppercase; background: var(--surface); position: sticky; top: 0; z-index: 1; }
td small { display: block; color: var(--muted); margin-top: 2px; }
.table-wrap { overflow: auto; max-height: 430px; }
.agent-row { cursor: pointer; }
.agent-row:hover, .agent-row.selected { background: var(--hover); }
.empty { padding: 18px; color: var(--muted); }
.pill { display: inline-flex; align-items: center; border-radius: 999px; padding: 2px 8px; font-size: 11px; background: var(--pill-bg); color: var(--pill-ink); border: 1px solid var(--pill-line); white-space: nowrap; }
.online, .healthy, .succeeded, .approved, .low { color: var(--green); border-color: var(--ok-line); background: var(--ok-bg); }
.stale, .warning, .needs_approval, .medium, .blocked, .quarantined { color: var(--amber); border-color: var(--warn-line); background: var(--warn-bg); }
.offline, .unhealthy, .failed, .critical, .high, .cancelled, .rejected { color: var(--red); border-color: var(--bad-line); background: var(--bad-bg); }
.queue-item.attention { border-left: 3px solid var(--red); background: var(--attention-bg); }
.attention-badge { color: var(--red); font-weight: 700; margin-left: 6px; font-size: 11px; }
.plan-status, .execution-status { display: block; margin-top: 4px; }
.plan-pending { color: var(--amber); }
.plan-admitted { color: var(--green); }
.execution-status { color: var(--muted-strong) !important; }
.queue-filter { padding: 12px 14px; border-bottom: 1px solid var(--line); background: var(--surface); display: grid; gap: 10px; }
.queue-filter-row { display: grid; gap: 8px; }
.queue-filter-fields { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.queue-filter-statuses { margin: 0; padding: 0; border: 0; }
.queue-filter-statuses legend { color: var(--muted); font-size: 11px; text-transform: uppercase; margin-bottom: 6px; }
.queue-filter-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.queue-filter-chip { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--control-line); background: var(--control-bg); border-radius: 999px; padding: 4px 10px; font-size: 12px; color: var(--ink); cursor: pointer; }
.queue-filter-chip:has(input:checked) { border-color: var(--control-hover-line); background: var(--hover); color: var(--accent); }
.queue-filter-chip input { width: auto; margin: 0; accent-color: var(--accent); }
.queue-filter-field { display: grid; gap: 5px; color: var(--muted); font-size: 12px; }
.queue-filter-live { margin: 0; color: var(--muted); font-size: 12px; }
.queue-item-filtered-out, .queue-item[hidden] { display: none !important; }
.queue { display: grid; }
.queue-item { text-align: left; background: transparent; color: var(--ink); border: 0; border-bottom: 1px solid var(--soft-line); padding: 12px 14px; cursor: pointer; }
.queue-item:hover, .queue-item.selected { background: var(--hover); }
.queue-item.selected { box-shadow: inset 3px 0 0 var(--accent); }
.approval-item > button { text-align: left; background: transparent; color: inherit; border: 0; cursor: pointer; }
.approval-actions { display: flex; gap: 8px; }
.approval-actions button { border: 1px solid var(--control-line); background: var(--control-bg); color: var(--ink); border-radius: 8px; padding: 8px 10px; cursor: pointer; }
.approval-actions button:hover { background: var(--hover); border-color: var(--control-hover-line); }
.approval-actions button:last-child { color: var(--red); border-color: var(--bad-line); }
.system-panel { padding: 18px; display: grid; grid-template-columns: 130px 1fr; gap: 16px; align-items: start; }
.system-panel strong { font-size: 44px; color: var(--green); }
.system-panel span { color: var(--muted); margin-top: 52px; margin-left: -130px; }
.system-panel dl { margin: 0; display: grid; gap: 8px; }
.system-panel div { display: flex; justify-content: space-between; gap: 14px; border-bottom: 1px solid var(--soft-line); padding-bottom: 7px; }
.system-panel dt { color: var(--muted); }
.system-panel dd { margin: 0; color: var(--ink); }
.operator-metrics { padding: 18px; display: grid; gap: 14px; }
.operator-metrics dl { margin: 0; display: grid; gap: 8px; }
.operator-metrics div { display: flex; justify-content: space-between; gap: 14px; border-bottom: 1px solid var(--soft-line); padding-bottom: 7px; }
.operator-metrics dt { color: var(--muted); }
.operator-metrics dd { margin: 0; color: var(--ink); font-variant-numeric: tabular-nums; }
.metrics-scrape { margin: 0; color: var(--muted); font-size: 13px; line-height: 1.45; }
.metrics-scrape code { font-size: 12px; }
.queue-item strong, .queue-item small { display: block; margin-top: 6px; }
.queue-item small { color: var(--muted); }
.error-line { color: var(--red) !important; }
.approvals-grid { grid-template-columns: 1fr; }
.approval-controls { padding: 14px; border-bottom: 1px solid var(--line); }
.approvals-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px; padding: 14px; }
.approval-item { border: 1px solid var(--line); border-radius: 8px; background: var(--surface-2); padding: 12px; display: grid; gap: 9px; }
.approval-item strong, .approval-item small { display: block; }
.agent-layout { display: grid; }
.detail-panel { margin: 12px; padding: 14px; max-height: 360px; overflow: auto; background: var(--surface-2); border: 1px solid var(--line); border-radius: 8px; color: var(--ink); }
.detail-empty, .detail-loading, .detail-error { color: var(--muted); }
.detail-error { color: var(--red); }
.detail-head { display: flex; justify-content: space-between; gap: 12px; align-items: start; border-bottom: 1px solid var(--soft-line); padding-bottom: 12px; margin-bottom: 12px; }
.detail-head h3 { margin: 0; font-size: 16px; }
.detail-head small { color: var(--muted); }
.detail-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 9px 14px; margin: 0; }
.detail-grid.compact { margin-top: 10px; }
.detail-grid div { min-width: 0; }
.detail-grid dt { color: var(--muted); font-size: 11px; text-transform: uppercase; }
.detail-grid dd { margin: 2px 0 0; overflow-wrap: anywhere; }
.detail-section { margin-top: 14px; }
.detail-section h4 { margin: 0 0 8px; font-size: 13px; color: var(--ink); }
.execution-stack { display: grid; gap: 10px; }
.execution-card { border: 1px solid var(--line); background: var(--surface); border-radius: 8px; padding: 10px; }
.execution-head, .lease-head { display: flex; justify-content: space-between; align-items: start; gap: 10px; }
.execution-head small { display: block; color: var(--muted); margin-top: 2px; }
.lease-block { border-top: 1px solid var(--soft-line); margin-top: 10px; padding-top: 10px; }
.lease-head strong { font-size: 12px; }
.chip-list { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { border: 1px solid var(--control-line); background: var(--control-bg); border-radius: 999px; padding: 4px 8px; font-size: 12px; color: var(--ink); }
.detail-events { list-style: none; display: grid; gap: 8px; margin: 0; padding: 0; }
.detail-events li { border-left: 2px solid var(--accent); padding-left: 10px; }
.detail-events time, .detail-events small { display: block; color: var(--muted); font-size: 11px; }
.action-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.action-list li { border: 1px solid var(--line); border-radius: 8px; padding: 8px; background: var(--surface); }
.action-list small { display: block; color: var(--muted); margin-top: 2px; }
.muted { color: var(--muted); font-size: 13px; }
form { display: grid; gap: 11px; padding: 14px; }
label { display: grid; gap: 5px; color: var(--muted); font-size: 12px; }
input, textarea, select { width: 100%; background: var(--control-bg); color: var(--ink); border: 1px solid var(--control-line); border-radius: 8px; padding: 10px; }
.field-hint { color: var(--muted); font-size: 11px; margin-top: -4px; }
.field-error { color: var(--red); font-size: 12px; min-height: 0; }
.field-hint.field-error { color: var(--amber); }
textarea[aria-invalid="true"] { border-color: var(--red); }
.composer-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.composer-preview { border: 1px dashed var(--line); border-radius: 6px; padding: 8px 10px; font-size: 12px; }
.composer-preview p { margin: 0 0 4px; }
.composer-preview[data-outcome="auto_admitted"] { border-color: var(--green); }
.composer-preview[data-outcome="needs_approval"] { border-color: var(--amber); }
.composer-preview[data-outcome="blocked"], .composer-preview[data-outcome="rejected"] { border-color: var(--red); }
.preview-actions { margin: 4px 0; padding-left: 16px; }
.form-row { display: grid; grid-template-columns: 160px 1fr; gap: 10px; }
button[type=submit] { background: var(--primary); color: var(--primary-ink); border: 0; border-radius: 9px; padding: 11px 14px; font-weight: 700; cursor: pointer; }
output { color: var(--accent); min-height: 20px; }
.timeline { list-style: none; margin: 0; padding: 10px 14px 14px; display: grid; gap: 10px; }
.timeline li { border-left: 2px solid var(--primary); padding-left: 10px; }
.timeline time, .timeline small { display: block; color: var(--muted); font-size: 11px; word-break: break-word; }
.skip-link { position: absolute; left: -9999px; top: 0; z-index: 1000; background: var(--primary); color: var(--primary-ink); padding: 10px 14px; border-radius: 8px; font-weight: 700; }
.skip-link:focus { left: 12px; top: 12px; }
:focus { outline: none; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.approval-actions button:focus-visible, .queue-item:focus-visible, nav a:focus-visible, button[type=submit]:focus-visible, .agent-row:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.reason-field { display: grid; gap: 5px; }
.reason-label { color: var(--muted); font-size: 12px; }
.reason-label .req { color: var(--red); font-weight: 600; }
.approval-result { display: block; min-height: 1.25em; }
.approval-actions button:disabled { opacity: .55; cursor: not-allowed; }
.approval-actions button .hash-prefix { font-size: 11px; opacity: .8; margin-left: 4px; }
.approval-confirm-overlay { position: fixed; inset: 0; z-index: 2000; background: var(--overlay); display: grid; place-items: center; padding: 16px; }
.approval-confirm-card { width: min(420px, 100%); background: var(--surface); border: 1px solid var(--line); border-radius: 10px; box-shadow: 0 18px 40px var(--shadow); padding: 18px; display: grid; gap: 10px; color: var(--ink); }
.approval-confirm-card h3 { margin: 0; font-size: 16px; }
.approval-confirm-card p { margin: 0; color: var(--muted); font-size: 13px; }
.approval-confirm-card code { color: var(--ink); font-size: 12px; }
.approval-confirm-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 6px; }
.approval-confirm-actions button { border: 1px solid var(--control-line); background: var(--control-bg); color: var(--ink); border-radius: 8px; padding: 8px 12px; cursor: pointer; min-height: 40px; }
.approval-confirm-actions button:hover { background: var(--hover); border-color: var(--control-hover-line); }
#approval-confirm-ok { background: var(--bad-bg); color: var(--red); border-color: var(--bad-line); font-weight: 700; }
#approval-confirm-cancel:focus-visible, #approval-confirm-ok:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
@media (min-width: 1520px) { .agent-layout { grid-template-columns: minmax(720px, 1fr) 380px; } .agent-detail { margin-left: 0; max-height: 430px; } }
@media (max-width: 1180px) { body { grid-template-columns: 1fr; } aside { position: static; height: auto; } .cards, .grid, .lower { grid-template-columns: 1fr; } .rail-note { position: static; } }
@media (max-width: 767px) {
  body { grid-template-columns: 1fr; }
  aside { position: static; height: auto; padding: 12px 14px; }
  nav { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 14px; }
  nav a { padding: 8px 10px; font-size: 13px; }
  .rail-note { display: none; }
  main { padding: 14px 12px 28px; }
  header { display: grid; gap: 10px; }
  .cards { grid-template-columns: 1fr; }
  .grid, .lower, .detail-grid, .form-row, .system-panel { grid-template-columns: 1fr; }
  .system-panel span { margin: 0; }
  .approvals-list { grid-template-columns: 1fr; padding: 12px; }
  .approval-actions { flex-direction: column; }
  .approval-actions button { width: 100%; min-height: 44px; font-size: 15px; }
  .table-wrap { max-height: none; }
  .agent-table th:nth-child(n+5), .agent-table td:nth-child(n+5) { display: none; }
  .queue-filter-fields { grid-template-columns: 1fr; }
  .queue-filter-chip { min-height: 44px; }
  .queue-item { padding: 14px 12px; min-height: 44px; }
  .detail-panel { margin: 8px; max-height: none; }
  .live { justify-self: start; white-space: normal; max-width: 100%; }
  .header-status { justify-items: start; }
}
body[data-active-view] [data-view-panel] { display: none; }
body[data-active-view="overview"] [data-view-panel~="overview"],
body[data-active-view="queue"] [data-view-panel~="queue"],
body[data-active-view="execution"] [data-view-panel~="execution"],
body[data-active-view="approvals"] [data-view-panel~="approvals"],
body[data-active-view="agents"] [data-view-panel~="agents"],
body[data-active-view="connectors"] [data-view-panel~="connectors"],
body[data-active-view="metrics"] [data-view-panel~="metrics"],
body[data-active-view="audit"] [data-view-panel~="audit"],
body[data-active-view="policy"] [data-view-panel~="policy"],
body[data-active-view="system"] [data-view-panel~="system"] { display: block; }
/* The view rule above must not flatten the overview card grid. */
body[data-active-view="overview"] #overview.cards { display: grid; }
.approval-item { background: var(--surface); color: var(--ink); border-color: var(--line); }
.system-probes { padding: 0 18px 16px; }
.system-probes dl { margin: 0; display: grid; gap: 8px; }
.system-probes div { display: flex; justify-content: space-between; gap: 12px; border-bottom: 1px solid var(--line); padding-bottom: 6px; }
.system-probes dt { color: var(--muted); }
.system-probes dd { margin: 0; }
`;
}
