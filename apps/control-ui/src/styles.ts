export function styles(): string {
  return `
:root {
  color-scheme: dark;
  font-family: Inter, ui-sans-serif, system-ui, sans-serif;
  background: #0e1116;
  color: #e8edf4;
  --bg: #0e1116;
  --surface: #171b22;
  --surface-2: #1e242e;
  --ink: #e8edf4;
  --muted: #a7b3c4;
  --line: #2a3342;
  --side: #10141a;
  --side-muted: #a7b3c4;
  --accent: #93bbff;
  --focus: #b5d0ff;
  --hover: #222e40;
  --selected: #263a56;
  --pressed: #304968;
  --success-bg: #123429;
  --success-border: #286c50;
  --warning-bg: #382e14;
  --warning-border: #79602a;
  --danger-bg: #3b2027;
  --danger-border: #88404b;
  --info-bg: #1c304d;
  --info-border: #3d608b;
  --neutral-bg: #252c38;
  --neutral-border: #495569;
  --green: #7ee2b8;
  --amber: #f5b942;
  --red: #ffabb1;
}
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; line-height: 1.5; background: var(--bg); display: grid; grid-template-columns: 216px minmax(0, 1fr); }
aside { border-right: 1px solid #252a30; padding: 22px 16px; background: var(--side); position: sticky; top: 0; height: 100vh; overflow-y: auto; }
.brand { color: #f8fafc; font-size: 20px; font-weight: 800; }
.brand span { display: block; color: var(--side-muted); font-size: 13px; margin-top: 4px; font-weight: 700; }
nav { display: grid; gap: 4px; margin-top: 30px; }
nav a { color: #c1c8d0; text-decoration: none; padding: 10px 12px; border-radius: 8px; }
nav a.active, nav a:hover { background: #27313b; color: var(--ink); }
.rail-note { color: var(--side-muted); font-size: 13px; line-height: 1.45; margin-top: 24px; }
main { padding: 22px 24px 40px; min-width: 0; }
header { display: flex; justify-content: space-between; align-items: start; gap: 16px; margin-bottom: 18px; }
h1 { margin: 0; font-size: 26px; color: var(--ink); }
p { color: var(--muted); margin: 6px 0 0; }
.live { border: 1px solid var(--line); border-radius: 999px; padding: 8px 12px; color: var(--muted); background: var(--surface); white-space: nowrap; }
.live span { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--green); margin-right: 8px; }
.live.disconnected span { background: var(--red); }
.stale-banner { margin-bottom: 14px; padding: 10px 14px; border: 1px solid var(--warning-border); background: var(--warning-bg); color: var(--amber); border-radius: 8px; font-weight: 600; }
.stale-banner[hidden] { display: none; }
.header-controls { display: flex; gap: 12px; align-items: start; }
.execution-mode { border: 1px solid var(--line); border-radius: 8px; padding: 8px 12px; background: var(--surface); }
.execution-mode legend { font-size: 13px; font-weight: 700; padding: 0 4px; }
.execution-mode label { display: block; margin-top: 4px; }
.admin-mode-banner { margin: 0 0 14px; padding: 12px 14px; border: 2px solid #ffb020; background: #3a2508; color: #ffd27a; border-radius: 8px; font-weight: 800; letter-spacing: .02em; }
.cards { display: grid; grid-template-columns: repeat(12, minmax(0, 1fr)); gap: 12px; margin-bottom: 14px; }
.card, .panel { border: 1px solid var(--line); background: var(--surface); border-radius: 8px; box-shadow: 0 10px 24px rgba(23, 32, 42, .06); }
.card { grid-column: span 3; padding: 15px; min-height: 108px; }
.card:nth-child(n+5) { grid-column: span 4; }
.card span, .panel-head span { color: var(--muted); font-size: 13px; text-transform: uppercase; }
.card strong { display: block; font-size: 30px; margin-top: 10px; color: var(--ink); }
.card p { font-size: 13px; line-height: 1.35; }
.grid { display: grid; grid-template-columns: minmax(0, 1fr); gap: 14px; margin-bottom: 14px; }
.lower { grid-template-columns: minmax(0, 1fr); }
.panel { min-width: 0; overflow: visible; }
.panel-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 14px 16px; border-bottom: 1px solid var(--line); background: var(--surface-2); }
.panel-head p { font-size: 13px; margin-top: 3px; }
h2 { margin: 0; font-size: 16px; color: var(--ink); }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 11px 12px; border-bottom: 1px solid var(--line); vertical-align: top; font-size: 13px; }
th { color: var(--muted); font-size: 13px; text-transform: uppercase; background: var(--surface-2); position: sticky; top: 0; z-index: 1; }
td small { display: block; color: var(--muted); margin-top: 2px; }
.table-wrap { overflow-x: auto; min-width: 0; }
.agent-row { cursor: pointer; }
.agent-row:hover, .agent-row.selected { background: var(--hover); }
.empty { padding: 18px; color: var(--muted); }
.pill { display: inline-flex; align-items: center; border-radius: 999px; padding: 2px 8px; font-size: 13px; background: var(--surface-2); color: var(--muted); border: 1px solid var(--line); white-space: nowrap; }
.online, .healthy, .succeeded, .approved, .low { color: var(--green); border-color: var(--success-border); background: var(--success-bg); }
.stale, .warning, .needs_approval, .medium, .blocked, .quarantined { color: var(--amber); border-color: var(--warning-border); background: var(--warning-bg); }
.offline, .unhealthy, .failed, .critical, .high, .cancelled, .rejected { color: var(--red); border-color: var(--danger-border); background: var(--danger-bg); }
.queue-item.attention { border-left: 3px solid var(--red); background: var(--danger-bg); }
.attention-badge { color: var(--red); font-weight: 700; margin-left: 6px; font-size: 13px; }
.plan-status, .execution-status { display: block; margin-top: 4px; }
.plan-pending { color: var(--amber); }
.plan-admitted { color: var(--green); }
.execution-status { color: var(--muted) !important; }
.queue-filter { padding: 12px 14px; border-bottom: 1px solid var(--line); background: var(--surface-2); display: grid; gap: 10px; }
.queue-filter-row { display: grid; gap: 8px; }
.queue-filter-fields { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.queue-filter-statuses { margin: 0; padding: 0; border: 0; }
.queue-filter-statuses legend { color: var(--muted); font-size: 13px; text-transform: uppercase; margin-bottom: 6px; }
.queue-filter-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.queue-filter-chip { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--line); background: var(--surface); border-radius: 999px; padding: 4px 10px; font-size: 13px; color: var(--ink); cursor: pointer; }
.queue-filter-chip:has(input:checked) { border-color: var(--focus); background: var(--hover); color: var(--accent); }
.queue-filter-chip input { width: auto; margin: 0; accent-color: var(--accent); }
.queue-filter-field { display: grid; gap: 5px; color: var(--muted); font-size: 13px; }
.queue-filter-live { margin: 0; color: var(--muted); font-size: 13px; }
.queue-item-filtered-out, .queue-item[hidden] { display: none !important; }
.queue { display: grid; }
.queue-item { text-align: left; background: transparent; color: var(--ink); border: 0; border-bottom: 1px solid var(--line); padding: 12px 14px; cursor: pointer; }
.queue-item:hover, .queue-item.selected { background: var(--hover); }
.queue-item.selected { box-shadow: inset 3px 0 0 var(--accent); }
.approval-item > button { text-align: left; background: transparent; color: inherit; border: 0; cursor: pointer; }
.approval-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.approval-actions button { border: 1px solid var(--line); background: var(--surface); color: var(--ink); border-radius: 8px; padding: 8px 10px; cursor: pointer; }
.approval-actions button:hover { background: var(--hover); border-color: var(--focus); }
.approval-actions button:last-child { color: var(--red); border-color: var(--danger-border); }
.system-panel { padding: 18px; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; align-items: start; }
.system-panel strong { font-size: 44px; color: var(--green); }
.system-panel span { color: var(--muted); margin-top: 52px; margin-left: -130px; }
.system-panel dl { margin: 0; display: grid; gap: 8px; }
.system-panel dl > div { display: flex; justify-content: space-between; gap: 14px; border-bottom: 1px solid var(--line); padding-bottom: 7px; }
.system-panel dt { color: var(--muted); }
.system-panel dd { margin: 0; color: var(--ink); }
.operator-metrics { padding: 18px; display: grid; gap: 14px; }
.operator-metrics dl { margin: 0; display: grid; gap: 8px; }
.operator-metrics div { display: flex; justify-content: space-between; gap: 14px; border-bottom: 1px solid var(--line); padding-bottom: 7px; }
.operator-metrics dt { color: var(--muted); }
.operator-metrics dd { margin: 0; color: var(--ink); font-variant-numeric: tabular-nums; }
.metrics-scrape { margin: 0; color: var(--muted); font-size: 13px; line-height: 1.45; }
.metrics-scrape code { font-size: 13px; }
.queue-item strong, .queue-item small { display: block; margin-top: 6px; }
.queue-item small { color: var(--muted); }
.error-line { color: var(--red) !important; }
.approvals-grid { grid-template-columns: 1fr; }
.approval-controls { padding: 14px; border-bottom: 1px solid var(--line); }
.approvals-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 340px), 1fr)); gap: 12px; padding: 14px; }
.approval-item { border: 1px solid var(--line); border-radius: 8px; background: var(--surface-2); padding: 12px; display: grid; gap: 9px; }
.approval-item strong, .approval-item small { display: block; }
.agent-layout { display: grid; }
.detail-panel { margin: 12px; padding: 14px; min-width: 0; background: var(--surface-2); border: 1px solid var(--line); border-radius: 8px; color: var(--ink); }
.detail-empty, .detail-loading, .detail-error { color: var(--muted); }
.detail-error { color: var(--red); }
.detail-head { display: flex; justify-content: space-between; gap: 12px; align-items: start; border-bottom: 1px solid var(--line); padding-bottom: 12px; margin-bottom: 12px; }
.detail-head h3 { margin: 0; font-size: 16px; }
.detail-head small { color: var(--muted); }
.detail-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 9px 14px; margin: 0; }
.detail-grid.compact { margin-top: 10px; }
.detail-grid div { min-width: 0; }
.detail-grid dt { color: var(--muted); font-size: 13px; text-transform: uppercase; }
.detail-grid dd { margin: 2px 0 0; overflow-wrap: anywhere; }
.detail-section { margin-top: 14px; }
.detail-section h4 { margin: 0 0 8px; font-size: 13px; color: var(--ink); }
.execution-stack { display: grid; gap: 10px; }
.execution-card { border: 1px solid var(--line); background: var(--surface); border-radius: 8px; padding: 10px; }
.execution-head, .lease-head { display: flex; justify-content: space-between; align-items: start; gap: 10px; }
.execution-head small { display: block; color: var(--muted); margin-top: 2px; }
.lease-block { border-top: 1px solid var(--line); margin-top: 10px; padding-top: 10px; }
.lease-head strong { font-size: 13px; }
.chip-list { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { border: 1px solid var(--line); background: var(--surface); border-radius: 999px; padding: 4px 8px; font-size: 13px; color: var(--ink); }
.detail-events { list-style: none; display: grid; gap: 8px; margin: 0; padding: 0; }
.detail-events li { border-left: 2px solid var(--accent); padding-left: 10px; }
.detail-events time, .detail-events small { display: block; color: var(--muted); font-size: 13px; }
.action-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.action-list li { border: 1px solid var(--line); border-radius: 8px; padding: 8px; background: var(--surface); }
.action-list small { display: block; color: var(--muted); margin-top: 2px; }
.muted { color: var(--muted); font-size: 13px; }
form { display: grid; gap: 11px; padding: 14px; }
label { display: grid; gap: 5px; color: var(--muted); font-size: 13px; }
input:not([type=checkbox]):not([type=radio]), textarea, select { width: 100%; background: var(--surface); color: var(--ink); border: 1px solid var(--line); border-radius: 8px; padding: 10px; }
.form-row { display: grid; grid-template-columns: minmax(100px, .4fr) minmax(0, 1fr); gap: 10px; }
button[type=submit] { background: #2563eb; color: #ffffff; border: 0; border-radius: 9px; padding: 11px 14px; font-weight: 700; cursor: pointer; }
output { color: var(--accent); min-height: 20px; }
.timeline { list-style: none; margin: 0; padding: 10px 14px 14px; display: grid; gap: 10px; }
.timeline li { border-left: 2px solid #2563eb; padding-left: 10px; }
.timeline time, .timeline small { display: block; color: var(--muted); font-size: 13px; word-break: break-word; }
.skip-link { position: absolute; left: -9999px; top: 0; z-index: 1000; background: #2563eb; color: var(--ink); padding: 10px 14px; border-radius: 8px; font-weight: 700; }
.skip-link:focus { left: 12px; top: 12px; }
:focus { outline: none; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.approval-actions button:focus-visible, .queue-item:focus-visible, nav a:focus-visible, button[type=submit]:focus-visible, .agent-row:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.reason-field { display: grid; gap: 5px; }
.reason-label { color: var(--muted); font-size: 13px; }
.reason-label .req { color: var(--red); font-weight: 600; }
.approval-result { display: block; min-height: 1.25em; }
.approval-actions button:disabled { opacity: .7; cursor: not-allowed; }
.approval-actions button .hash-prefix { font-size: 13px; opacity: .8; margin-left: 4px; }
.approval-confirm-overlay { position: fixed; inset: 0; z-index: 2000; background: rgba(17, 20, 23, .45); display: grid; place-items: center; padding: 16px; }
.approval-confirm-card { width: min(420px, 100%); background: var(--surface); border: 1px solid var(--line); border-radius: 10px; box-shadow: 0 18px 40px rgba(23, 32, 42, .22); padding: 18px; display: grid; gap: 10px; color: var(--ink); }
.approval-confirm-card h3 { margin: 0; font-size: 16px; }
.approval-confirm-card p { margin: 0; color: var(--muted); font-size: 13px; }
.approval-confirm-card code { color: var(--ink); font-size: 13px; }
.approval-confirm-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 6px; }
.approval-confirm-actions button { border: 1px solid var(--line); background: var(--surface); color: var(--ink); border-radius: 8px; padding: 8px 12px; cursor: pointer; min-height: 40px; }
.approval-confirm-actions button:hover { background: var(--hover); border-color: var(--focus); }
#approval-confirm-ok { background: var(--danger-bg); color: var(--red); border-color: var(--danger-border); font-weight: 700; }
#approval-confirm-cancel:focus-visible, #approval-confirm-ok:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
 .roster-panel { container-type: inline-size; }
@container (min-width: 1120px) { .agent-layout { grid-template-columns: minmax(0, 1fr) minmax(320px, .4fr); align-items: start; } }
@media (max-width: 1180px) {
  body { grid-template-columns: 1fr; }
  aside { position: static; height: auto; padding: 12px 20px; }
  nav { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 12px; }
  .rail-note { display: none; }
  .brand span { display: inline; margin-left: 10px; }
}
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
  /* Operational columns remain available through horizontal table scrolling. */
  .queue-filter-fields { grid-template-columns: 1fr; }
  .queue-filter-chip { min-height: 44px; }
  .queue-item { padding: 14px 12px; min-height: 44px; }
  .detail-panel { margin: 8px; max-height: none; }
  .live { justify-self: start; }
}
.panel-head, th, .queue-filter, .detail-panel, .execution-card, .approval-item, .approval-actions button, .queue-filter-chip, input, textarea, select, .approval-confirm-card, .chip, .action-list li { background: var(--surface); color: var(--ink); border-color: var(--line); }
.stale-banner { background: var(--warning-bg); color: var(--amber); border-color: var(--warning-border); }
.agent-row:hover, .queue-item:hover { background: var(--hover); }
.agent-row.selected, .queue-item.selected { background: var(--selected); box-shadow: inset 3px 0 var(--accent); }
.queue-item.attention { border-left-color: var(--amber); }
nav a:hover { background: var(--hover); color: var(--ink); }
nav a.active { background: var(--selected); color: var(--ink); box-shadow: inset 3px 0 var(--accent); }
.system-probes { padding: 0 18px 16px; }
.system-probes dl { margin: 0; display: grid; gap: 8px; }
.system-probes div { display: flex; justify-content: space-between; gap: 12px; border-bottom: 1px solid var(--line); padding-bottom: 6px; }
.system-probes dt { color: var(--muted); }
.system-probes dd { margin: 0; }
[hidden] { display: none !important; }
a { color: var(--accent); text-underline-offset: 3px; }
button, input, textarea, select { font: inherit; }
button, .button { min-height: 44px; border: 1px solid var(--line); border-radius: 8px; padding: 8px 12px; color: var(--ink); background: var(--surface-2); cursor: pointer; }
button, a, input, select, textarea, summary { transition: color 120ms, border-color 120ms, background-color 120ms; }
button:hover:not(:disabled), .button:hover { background: var(--hover); border-color: var(--focus); }
button:active:not(:disabled), .button:active { background: var(--pressed); }
button:disabled { opacity: .7; cursor: not-allowed; }
:focus-visible { outline: 3px solid var(--focus); outline-offset: 3px; }
[aria-busy=true] { cursor: progress; }
.detail-panel[aria-busy=true]::before { content: "Refreshing…"; display: block; color: var(--muted); font-size: 13px; }
input[type=checkbox], input[type=radio] { width: 18px; height: 18px; accent-color: #2563eb; flex: 0 0 auto; }
.execution-mode label, .audit-controls label { display: flex; align-items: center; gap: 8px; min-height: 44px; }
.execution-mode { width: 360px; max-width: 100%; margin: 0; }
.execution-mode p { font-size: 13px; }
#execution-mode-active { color: var(--ink); font-weight: 700; }
.header-controls { flex-wrap: wrap; }
.connection-status { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.eyebrow { margin: 0 0 4px; font-size: 13px; }
.view-actions { display: flex; justify-content: flex-end; margin: 0 0 16px; }
.button { display: inline-flex; align-items: center; text-decoration: none; }
.card { text-decoration: none; }
.card:hover { border-color: var(--focus); background: var(--hover); }
.card strong, time, dd, .freshness { font-variant-numeric: tabular-nums; }
.card span { text-transform: none; }
.freshness { padding: 8px 16px; font-size: 13px; }
.freshness[data-state=unavailable], .freshness[data-state=stale] { color: var(--amber); }
.agent-name { background: transparent; padding: 0; border: 0; font-weight: 600; text-align: left; overflow-wrap: anywhere; }
.selected-label { color: var(--accent); font-size: 13px; }
.agent-table { min-width: 740px; }
td { overflow-wrap: anywhere; max-width: 300px; }
.queue-item strong { font-size: 15px; }
.queue-item small { font-size: 13px; line-height: 1.5; overflow-wrap: anywhere; }
.queue-item .queue-intent, .queue-item .error-line { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
body[data-active-view=execution] .queue-item .queue-intent, .queue-item .error-line { display: none; }
body[data-active-view=execution] .execution-status { font-weight: 600; }
#execution-help { padding: 12px 16px; }
#queue-empty, #queue-no-matches { margin: 0; }
body[data-active-view=overview] .approvals-list .approval-item:nth-child(n+4) { display: none; }
body:not([data-active-view=overview]) .view-all { display: none; }
.view-all { margin: 8px 16px; display: inline-block; }
.safety-help { padding: 14px 16px; }
summary { cursor: pointer; min-height: 44px; display: flex; align-items: center; gap: 8px; }
summary::before { content: '▸'; }
details[open] > summary::before { content: '▾'; }
.audit-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding: 12px 16px; }
.audit-controls span { font-size: 13px; color: var(--muted); }
.timeline li { border-left-color: var(--line); padding: 10px 12px; overflow-wrap: anywhere; }
.timeline time, .timeline small, .detail-events time, .detail-events small { font-size: 13px; }
.timeline pre { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13px; }
.timeline details { margin-top: 4px; }
.approval-confirm-card { max-height: calc(100dvh - 32px); overflow: auto; width: min(560px, 100%); }
.approval-confirm-card p, .approval-confirm-card code { overflow-wrap: anywhere; font-size: 14px; }
.approval-confirm-actions { flex-wrap: wrap; }
.approval-confirm-actions button { min-height: 44px; }
.pill { gap: 4px; line-height: 1.5; }
.pill.running, .pill.pending_policy { background: var(--info-bg); color: var(--accent); border-color: var(--info-border); }
.pill.unknown, .pill.observed, .pill.draft { background: var(--neutral-bg); color: var(--ink); border-color: var(--neutral-border); }
.pill.cancelled, .pill.rejected { background: var(--neutral-bg); color: var(--ink); border-color: var(--neutral-border); }
[aria-invalid=true] { border-color: var(--red); }
.system-panel { align-items: start; }
.system-probes { padding: 0; display: block; }
form p { font-size: 13px; }
/* Screenshot-target Mission Control shell */
:root {
  --bg: #06111d;
  --surface: #0a1928;
  --surface-2: #0c2033;
  --ink: #e8f0f8;
  --muted: #88a0b8;
  --line: #1b3650;
  --side: #071624;
  --side-muted: #7f98b1;
  --accent: #45a5ff;
  --focus: #69b8ff;
  --hover: #102b44;
  --selected: #102f4e;
  --pressed: #153b60;
  --success-bg: rgba(11, 119, 78, .22);
  --success-border: #147d59;
  --warning-bg: rgba(142, 101, 5, .20);
  --warning-border: #846617;
  --danger-bg: rgba(129, 31, 52, .20);
  --danger-border: #8d2b43;
  --info-bg: rgba(10, 86, 166, .23);
  --info-border: #155a9d;
  --neutral-bg: #122235;
  --neutral-border: #2b4661;
  --green: #45e39a;
  --amber: #f3c63d;
  --red: #ff657a;
}
body {
  grid-template-columns: 190px minmax(0, 1fr);
  grid-template-rows: 86px minmax(0, 1fr);
  background:
    radial-gradient(circle at 62% -20%, rgba(31, 91, 142, .16), transparent 35%),
    linear-gradient(180deg, #07131f 0%, #06111d 100%);
  color: var(--ink);
}
.mission-topbar {
  grid-column: 1 / -1;
  grid-row: 1;
  position: sticky;
  top: 0;
  z-index: 50;
  min-width: 0;
  display: grid;
  grid-template-columns: 286px minmax(300px, 400px) minmax(250px, 1fr) minmax(220px, 300px) auto;
  align-items: center;
  gap: 18px;
  min-height: 86px;
  padding: 12px 20px;
  border-bottom: 1px solid #173049;
  background: rgba(5, 17, 29, .96);
  backdrop-filter: blur(18px);
}
.topbar-brand { display: flex; align-items: center; gap: 14px; min-width: 0; }
.acs-mark { position: relative; width: 38px; height: 42px; flex: 0 0 auto; }
.acs-mark::before, .acs-mark::after, .acs-mark i {
  content: ""; position: absolute; left: 50%; width: 0; height: 0; transform: translateX(-50%);
  border-left: 11px solid transparent; border-right: 11px solid transparent;
}
.acs-mark::before { top: 0; border-bottom: 25px solid #68b7ff; }
.acs-mark::after { bottom: 1px; border-top: 22px solid #1f67b5; }
.acs-mark i { top: 13px; border-left-width: 7px; border-right-width: 7px; border-bottom: 17px solid #06111d; z-index: 2; }
.acs-mark b { position: absolute; inset: 0; }
.topbar-brand > div { display: flex; align-items: baseline; gap: 16px; min-width: 0; }
.topbar-brand > div > strong { font-size: 22px; }
.topbar-brand > div > span { font-size: 18px; white-space: nowrap; }
.topbar-brand small { display: block; margin-top: 2px; color: var(--muted); font-size: 11px; font-weight: 500; }
.mode-status-chip {
  display: flex; align-items: center; gap: 12px; min-width: 0;
  min-height: 58px; padding: 9px 16px; border: 1px solid #24445e; border-radius: 9px;
  background: linear-gradient(135deg, rgba(16, 42, 64, .95), rgba(9, 28, 44, .95));
}
.mode-status-chip.strict { box-shadow: inset 3px 0 0 #43dc97; }
.mode-status-chip.admin { box-shadow: inset 3px 0 0 var(--amber); }
.mode-status-chip.unavailable { box-shadow: inset 3px 0 0 var(--red); }
.mode-status-chip.unavailable .mode-shield { color: var(--red); background: rgba(255,101,122,.12); }
.mode-shield { display: grid; place-items: center; width: 34px; height: 34px; border-radius: 9px; background: rgba(67, 220, 151, .16); color: #43dc97; }
.mode-status-chip.admin .mode-shield { color: var(--amber); background: rgba(243,198,61,.13); }
.mode-status-chip strong, .status-cluster strong { display: block; font-size: 13px; }
.mode-status-chip small, .status-cluster small { display: block; color: var(--muted); font-size: 11px; margin-top: 2px; }
.topbar-statuses { display: flex; justify-content: center; gap: 30px; min-width: 0; }
.status-cluster { display: flex; align-items: center; gap: 9px; white-space: nowrap; }
.top-status-dot, .health-dot, .legend-dot, .event-dot {
  display: inline-block; width: 10px; height: 10px; border-radius: 50%; background: var(--green);
  box-shadow: 0 0 12px rgba(69, 227, 154, .45);
}
.top-status-dot.pending { background: var(--amber); box-shadow: none; }
.top-status-dot.degraded { background: var(--red); box-shadow: 0 0 10px rgba(255,101,122,.28); }
.top-status-dot.ok { background: var(--green); box-shadow: 0 0 12px rgba(69,227,154,.45); }
.mission-topbar .live { border: 0; padding: 0; background: transparent; border-radius: 0; color: var(--muted); }
.mission-topbar .live > span { width: 7px; height: 7px; margin-right: 5px; }
.global-search {
  min-width: 0; display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 8px;
  padding: 0 11px; min-height: 42px; border: 1px solid #24445e; border-radius: 9px; background: #091b2b; color: #7390aa;
}
.global-search input { min-width: 0; border: 0 !important; background: transparent !important; padding: 0 !important; outline: 0; color: var(--ink); }
.global-search kbd { border: 1px solid #28465f; border-radius: 5px; padding: 1px 6px; font-size: 11px; color: #7591aa; background: #0b2235; }
.operator-chip { display: flex; align-items: center; gap: 10px; padding-left: 16px; border-left: 1px solid #294159; }
.operator-avatar { display: grid; place-items: center; width: 42px; height: 42px; border-radius: 50%; background: #223b54; border: 1px solid #335673; font-weight: 700; }
.operator-chip strong { display: block; font-size: 13px; }
.operator-chip small { color: var(--muted); font-size: 11px; }
aside {
  grid-column: 1; grid-row: 2; top: 86px; height: calc(100vh - 86px); padding: 12px 10px 16px;
  background: linear-gradient(180deg, #071624 0%, #06121e 100%); border-right: 1px solid #173049;
  display: flex; flex-direction: column;
}
aside nav { margin-top: 0; gap: 5px; }
nav a {
  display: grid; grid-template-columns: 26px minmax(0, 1fr) auto; align-items: center; gap: 8px;
  min-height: 46px; padding: 9px 11px; border-radius: 8px; color: #9fb4c8; font-size: 13px;
}
nav a > span { color: #89bce9; text-align: center; font-size: 18px; }
nav a.active { background: linear-gradient(90deg, #102e4c, #0d253e); box-shadow: none; color: #eef7ff; }
nav a.active > span { color: #4aa9ff; }
.nav-count { min-width: 22px; height: 22px; display: grid; place-items: center; border-radius: 999px; background: #ed4f65; color: #fff; font-size: 11px; }
.nav-health-dot { justify-self: end; width: 8px; height: 8px; border-radius: 50%; background: var(--amber); box-shadow: none; }
.nav-health-dot.ok { background: var(--green); box-shadow: 0 0 8px rgba(69,227,154,.35); }
.nav-health-dot.degraded { background: var(--amber); }
.nav-health-dot.unavailable { background: var(--red); }
.nav-divider { height: 1px; margin: 8px 6px; background: #16314a; }
.new-work-link {
  display: flex; align-items: center; gap: 10px; margin-top: 8px; padding: 12px; border-top: 1px solid #173049;
  color: #a9c1d7; text-decoration: none; font-size: 13px;
}
.new-work-link span { font-size: 20px; color: #83b8e9; }
.sidebar-footer { margin-top: auto; border: 1px solid #24445e; border-radius: 9px; padding: 13px; background: #0a2033; }
.sidebar-footer > div { display: flex; align-items: center; gap: 8px; }
.sidebar-footer strong { font-size: 12px; }
.sidebar-footer small { display: block; margin: 5px 0 9px 18px; color: var(--muted); font-size: 10px; }
.sidebar-footer a { display: block; margin-left: 18px; font-size: 10px; }
main { grid-column: 2; grid-row: 2; padding: 18px 20px 34px; max-width: 100%; }
.page-header { align-items: center; margin-bottom: 12px; }
.page-header h1 { font-size: 28px; letter-spacing: -.02em; }
.page-header p { margin-top: 1px; color: #82a5c4; font-size: 16px; }
.page-meta { display: flex; align-items: center; gap: 12px; color: var(--muted); font-size: 12px; }
.page-meta button { min-height: 36px; padding: 6px 10px; }
.stale-banner, .admin-mode-banner { margin-bottom: 10px; }
#state-result:empty { display: none; }
.overview-shell { min-width: 0; }
.overview-cards { grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 14px; margin-bottom: 16px; }
.card.overview-stat {
  position: relative; grid-column: auto !important; min-height: 106px; padding: 14px 16px 12px 62px;
  border-radius: 9px; overflow: hidden; background: linear-gradient(135deg, rgba(12,31,48,.98), rgba(8,24,39,.98));
}
.overview-stat .stat-icon { position: absolute; left: 15px; top: 17px; width: 38px; height: 38px; border-radius: 9px; background: currentColor; opacity: .16; }
.overview-stat .stat-icon::after { content: ""; position: absolute; inset: 10px; border: 2px solid currentColor; border-radius: 50%; opacity: 1; }
.overview-stat strong { display: inline-block; margin: 0; font-size: 28px; line-height: 1; }
.overview-stat b { display: block; margin-top: 5px; font-size: 13px; color: #f0f6fb; }
.overview-stat p { margin: 5px 0 0; font-size: 10px; color: #839cb4; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.overview-stat .stat-arrow { position: absolute; right: 14px; top: 16px; font-size: 18px; opacity: .75; }
.overview-stat.tone-danger { color: #ff586e; border-color: #a02f47; background: linear-gradient(135deg, rgba(73,22,38,.44), rgba(17,24,38,.96)); }
.overview-stat.tone-warning { color: #f1c437; border-color: #806619; background: linear-gradient(135deg, rgba(68,57,17,.40), rgba(17,28,38,.96)); }
.overview-stat.tone-info { color: #43a9ff; border-color: #175c98; background: linear-gradient(135deg, rgba(15,54,94,.48), rgba(10,27,43,.96)); }
.overview-stat.tone-success { color: #44df99; border-color: #177352; background: linear-gradient(135deg, rgba(10,68,53,.44), rgba(9,29,37,.96)); }
.panel { border-color: #1c3a55; background: linear-gradient(180deg, #0a1b2a 0%, #081725 100%); box-shadow: 0 12px 28px rgba(0,0,0,.15); border-radius: 9px; }
.panel-head { padding: 11px 14px; background: transparent; border-bottom-color: #18364f; }
.panel-head h2 { font-size: 14px; }
.panel-head a { font-size: 11px; text-decoration: none; }
.overview-grid { display: grid; gap: 14px; margin-bottom: 14px; }
.overview-grid-top { grid-template-columns: minmax(0, 1.8fr) minmax(260px, 1fr) minmax(260px, .9fr); }
.overview-grid-bottom { grid-template-columns: minmax(0, 1.45fr) minmax(320px, 1.1fr) minmax(260px, .9fr); }
.compact-table { max-height: 245px; }
.compact-table table { min-width: 540px; }
.compact-table th, .compact-table td { padding: 9px 11px; font-size: 11px; }
.compact-table th { background: transparent; text-transform: none; color: #80a0bd; font-weight: 500; }
.compact-table td strong { font-size: 11px; }
.compact-table td small { font-size: 10px; }
.health-list { margin: 0; padding: 6px 14px 10px; }
.health-list > div { display: flex; align-items: center; justify-content: space-between; gap: 14px; min-height: 35px; border-bottom: 1px solid #15334c; font-size: 11px; }
.health-list dt { color: #c2d0dc; }
.health-list dd { display: flex; align-items: center; gap: 7px; margin: 0; color: #91abc2; text-align: right; }
.health-dot { width: 8px; height: 8px; }
.health-dot.live-dot { background: var(--amber); box-shadow: none; }
.health-dot.live-dot.ok { background: var(--green); box-shadow: 0 0 10px rgba(69,227,154,.35); }
.agent-summary { display: grid; grid-template-columns: 130px minmax(0, 1fr); gap: 12px; align-items: center; padding: 16px; }
.agent-donut { --online-end: 0%; --observed-end: 0%; --stale-end: 0%; width: 112px; height: 112px; border-radius: 50%; display: grid; place-items: center; background: conic-gradient(#43d991 0 var(--online-end), #3e8fe5 var(--online-end) var(--observed-end), #f3c63d var(--observed-end) var(--stale-end), #6b87a1 var(--stale-end) 100%); position: relative; }
.agent-donut::after { content: ""; position: absolute; inset: 14px; border-radius: 50%; background: #091b2a; }
.agent-donut span { z-index: 1; display: grid; text-align: center; }
.agent-donut strong { font-size: 22px; }
.agent-donut small { color: var(--muted); font-size: 10px; }
.agent-summary dl { margin: 0; display: grid; gap: 7px; }
.agent-summary dl div { display: flex; justify-content: space-between; font-size: 11px; }
.agent-summary dt { display: flex; align-items: center; gap: 7px; color: #a6b9ca; }
.agent-summary dd { margin: 0; font-weight: 700; }
.legend-dot { width: 8px; height: 8px; box-shadow: none; }
.observed-dot { background: #3e8fe5; }
.stale-dot { background: var(--amber); }
.offline-dot { background: #6b87a1; }
.overview-events { list-style: none; margin: 0; padding: 4px 14px 10px; }
.overview-events li { display: grid; grid-template-columns: 10px minmax(0, 1fr) auto; gap: 9px; align-items: center; min-height: 39px; border-bottom: 1px solid #15334c; }
.overview-events strong, .overview-events small { display: block; font-size: 10px; }
.overview-events small, .overview-events time { color: #819ab0; }
.overview-events time { font-size: 10px; }
.event-dot { width: 8px; height: 8px; }
.overview-mode-panel { display: grid; grid-template-columns: 54px minmax(420px, 1.4fr) minmax(230px, .7fr) minmax(260px, .9fr); gap: 18px; align-items: center; padding: 14px 16px; }
.mode-panel-icon { width: 46px; height: 46px; display: grid; place-items: center; border-radius: 10px; color: #43dc97; background: rgba(30,137,88,.22); border: 1px solid #176942; font-size: 24px; }
.overview-mode-panel .execution-mode { width: auto; padding: 0; border: 0; background: transparent; display: grid; grid-template-columns: auto minmax(160px,1fr) minmax(210px,1fr) auto; align-items: center; gap: 9px; }
.overview-mode-panel .execution-mode legend { grid-column: 1 / -1; padding: 0; margin-bottom: 1px; font-size: 13px; }
.overview-mode-panel .execution-mode label { margin: 0; min-height: 48px; padding: 7px 10px; border: 1px solid #1c405f; border-radius: 8px; background: #0a1d2e; }
.overview-mode-panel .execution-mode label:has(input:checked) { border-color: #3d9ff4; box-shadow: inset 0 0 0 1px rgba(61,159,244,.22); }
.overview-mode-panel .execution-mode label span { display: grid; }
.overview-mode-panel .execution-mode label strong { font-size: 12px; color: #eaf3fb; }
.overview-mode-panel .execution-mode label small { font-size: 10px; color: #7894ad; }
.overview-mode-panel #execution-mode-apply { min-height: 38px; font-size: 11px; }
.overview-mode-panel #execution-mode-result { grid-column: 2 / -1; margin: 0; }
.mode-current { display: grid; gap: 5px; padding-left: 18px; border-left: 1px solid #1b3a55; }
.mode-current small, .mode-current p, .mode-safety-note { font-size: 10px; color: #829cb3; }
.mode-current strong { width: max-content; padding: 5px 10px; border-radius: 6px; border: 1px solid #177152; color: #43dc97; background: rgba(18,93,67,.20); font-size: 12px; text-transform: capitalize; }
.mode-safety-note { margin: 0; padding-left: 18px; border-left: 1px solid #1b3a55; line-height: 1.55; }
.visualizer-grid { margin-bottom: 0; }
.visualizer-panel { min-height: 620px; overflow: hidden; }
.visualizer-toolbar { display: flex; justify-content: space-between; gap: 18px; align-items: center; padding: 16px 18px; border-bottom: 1px solid #1b3a55; background: #091b2b; }
.visualizer-toolbar strong { font-size: 15px; }
.visualizer-toolbar p { margin: 2px 0 0; font-size: 11px; }
.viz-source-controls { display: flex; align-items: center; gap: 10px; }
.viz-source-status { color: #8ca3b8; font-size: 10px; white-space: nowrap; }
#visualizer-refresh { min-height: 34px; padding: 5px 9px; font-size: 10px; }
.visualizer-health-dot, .visualizer-page-health-dot { background: var(--amber); box-shadow: none; }
.visualizer-health-dot.ok, .visualizer-page-health-dot.ok { background: var(--green); box-shadow: 0 0 10px rgba(69,227,154,.35); }
.visualizer-health-dot.degraded, .visualizer-page-health-dot.degraded { background: var(--amber); box-shadow: none; }
.visualizer-health-dot.unavailable, .visualizer-page-health-dot.unavailable { background: var(--red); box-shadow: 0 0 10px rgba(255,101,122,.28); }
.viz-health-strip { min-height: 38px; display: flex; align-items: center; gap: 8px; padding: 8px 16px; border-bottom: 1px solid #17364f; background: #081827; color: #93a9bc; font-size: 10px; }
.viz-health-strip strong { color: #dce8f2; font-size: 10px; }
#visualizer-health-detail { margin-left: auto; color: #718da5; }
.viz-summary { display: grid; grid-template-columns: repeat(4, minmax(0,1fr)); gap: 10px; padding: 12px 16px; border-bottom: 1px solid #17364f; background: #091a29; }
.viz-summary > div { min-height: 54px; display: grid; align-content: center; justify-items: center; border: 1px solid #1e405d; border-radius: 7px; background: #0a1f31; }
.viz-summary strong { font-size: 19px; line-height: 1; }
.viz-summary span { margin-top: 4px; color: #7993aa; font-size: 9px; text-transform: uppercase; letter-spacing: .04em; }
.viz-filter { display: grid; grid-template-columns: minmax(220px,1fr) 180px 180px auto; gap: 10px; align-items: end; padding: 12px 16px; border-bottom: 1px solid #17364f; background: #081827; }
.viz-filter label { display: grid; gap: 4px; color: #819bb2; font-size: 9px; text-transform: uppercase; letter-spacing: .04em; }
.viz-filter input, .viz-filter select { min-height: 34px; margin: 0; padding: 6px 8px; border: 1px solid #29465d; border-radius: 6px; background: #0a1f31; color: var(--ink); font-size: 10px; }
#visualizer-filter-live { align-self: center; color: #748ea5; font-size: 10px; white-space: nowrap; }
.visualizer-canvas { padding: 18px; display: grid; gap: 12px; overflow-x: auto; background-image: radial-gradient(#18344d 1px, transparent 1px); background-size: 22px 22px; min-height: 560px; align-content: start; }
.viz-execution { min-width: 760px; border: 1px solid rgba(28,58,85,.72); border-radius: 9px; background: rgba(6,19,31,.88); overflow: hidden; }
.viz-execution-head { display: flex; justify-content: space-between; gap: 16px; align-items: center; padding: 10px 12px; border-bottom: 1px solid #18364f; background: rgba(10,31,49,.82); }
.viz-execution-head strong, .viz-execution-head small { display: block; }
.viz-execution-head strong { font-size: 12px; }
.viz-execution-head small { margin-top: 2px; color: #7590a8; font-size: 10px; }
.viz-execution-badges { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 5px; }
.viz-execution-badges .pill { font-size: 9px; padding: 2px 6px; }
.viz-projection-state { margin: 0; padding: 18px 14px; font-size: 11px; }
.viz-projection-state.pending { color: var(--amber); }
.viz-projection-state.unavailable { color: var(--red); }
.viz-canonical-graph { display: grid; gap: 8px; min-height: 88px; padding: 14px; overflow-x: auto; }
.viz-canonical-row { min-width: 620px; display: grid; grid-template-columns: minmax(210px, .8fr) minmax(240px, 1.2fr); gap: 14px; align-items: center; }
.viz-incoming { min-width: 0; display: grid; justify-items: end; gap: 4px; color: #718da5; font-size: 9px; }
.viz-incoming-edge { max-width: 100%; display: flex; align-items: center; gap: 7px; }
.viz-edge-parent { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.viz-edge-type { padding: 2px 5px; border: 1px solid #31546d; border-radius: 999px; color: #8faabd; font-size: 8px; text-transform: uppercase; }
.viz-root-label { color: #4aa9ff; font-weight: 700; letter-spacing: .08em; }
.viz-edge-missing { color: var(--amber); }
.viz-canonical-node { min-width: 240px; min-height: 54px; display: grid; align-content: center; gap: 3px; padding: 8px 10px; border: 1px solid #29465d; border-radius: 7px; background: #0d2132; color: #92a9bd; }
.viz-canonical-node strong { font-size: 10px; text-transform: capitalize; }
.viz-canonical-node small { font-size: 9px; color: inherit; opacity: .82; text-transform: capitalize; }
.viz-canonical-node.complete { color: #46dfa0; border-color: #1d7655; background: rgba(11,82,59,.20); }
.viz-canonical-node.active { color: #58adf8; border-color: #276d9f; background: rgba(18,75,119,.28); box-shadow: 0 0 18px rgba(43,130,201,.12); }
.viz-canonical-node.failed { color: #ff687c; border-color: #873245; background: rgba(98,25,43,.24); }
.viz-canonical-node.queued { color: #f2c447; border-color: #795f1d; background: rgba(82,66,19,.22); }
.viz-execution-meta { display: block; padding: 0 14px 10px; color: #66839a; font-size: 9px; overflow-wrap: anywhere; }
@media (max-width: 1320px) {
  .mission-topbar { grid-template-columns: 250px 330px minmax(220px,1fr) 250px; }
  .operator-chip { display: none; }
  .overview-grid-top, .overview-grid-bottom { grid-template-columns: 1fr 1fr; }
  .overview-approvals, .overview-queue { grid-column: 1 / -1; }
  .overview-mode-panel { grid-template-columns: 48px 1fr 230px; }
  .mode-safety-note { grid-column: 2 / -1; border-left: 0; padding-left: 0; }
}
@media (max-width: 1040px) {
  body { display: block; }
  .mission-topbar { position: sticky; top: 0; grid-template-columns: minmax(230px,1fr) auto auto; min-height: 72px; }
  .mode-status-chip { min-height: 48px; }
  .topbar-statuses { gap: 12px; }
  .global-search { display: none; }
  aside { position: static; top: auto; height: auto; padding: 8px 12px; border-right: 0; border-bottom: 1px solid #173049; }
  aside nav { display: flex; overflow-x: auto; flex-wrap: nowrap; gap: 4px; }
  nav a { grid-template-columns: 20px auto auto; flex: 0 0 auto; min-height: 40px; padding: 7px 10px; }
  .nav-divider, .sidebar-footer { display: none; }
  .new-work-link { display: none; }
  main { padding: 16px 14px 28px; }
  .overview-cards { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .overview-grid-top, .overview-grid-bottom { grid-template-columns: 1fr; }
  .overview-approvals, .overview-queue { grid-column: auto; }
  .overview-mode-panel { grid-template-columns: 48px 1fr; }
  .mode-current, .mode-safety-note { grid-column: 2; }
  .viz-filter { grid-template-columns: 1fr 1fr; }
  #visualizer-filter-live { grid-column: 1 / -1; }
}
@media (max-width: 700px) {
  .mission-topbar { grid-template-columns: 1fr auto; padding: 10px 12px; }
  .topbar-brand > div > span, .topbar-statuses { display: none; }
  .mode-status-chip { max-width: 220px; }
  .overview-cards { grid-template-columns: 1fr 1fr; }
  .overview-stat:last-child { grid-column: 1 / -1 !important; }
  .page-header { display: grid; }
  .page-meta { justify-content: space-between; }
  .overview-mode-panel { grid-template-columns: 1fr; }
  .mode-panel-icon { display: none; }
  .overview-mode-panel .execution-mode { grid-template-columns: 1fr; }
  .overview-mode-panel .execution-mode legend,
  .overview-mode-panel #execution-mode-result { grid-column: 1; }
  .mode-current, .mode-safety-note { grid-column: 1; border-left: 0; padding-left: 0; }
  .viz-health-strip { flex-wrap: wrap; }
  #visualizer-health-detail { width: 100%; margin-left: 18px; }
  .viz-summary { grid-template-columns: 1fr 1fr; }
  .viz-filter { grid-template-columns: 1fr; }
  #visualizer-filter-live { grid-column: 1; }
}
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition: none !important; animation: none !important; scroll-behavior: auto !important; } }
`;
}
