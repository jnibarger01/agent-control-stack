/** Mission Control visual tokens and shared operational layouts. */
export function premiumStyles(): string {
  return `
:root:not([data-theme="light"]) {
  --bg: #030d18; --surface: #071726; --surface-2: #102334; --ink: #edf4ff;
  --muted: #a6bbd5; --muted-strong: #b8cae2; --line: #1b344b; --soft-line: #142a3e;
  --side: #041321; --side-line: #173047; --side-muted: #a6bbd5; --brand: #f3f7ff;
  --nav-active-ink: #ffffff; --nav-ink: #b9cee7; --nav-active: #112f53; --accent: #58b8ff; --primary: #1263db;
  --control-bg: #0b1d2e; --control-line: #284359; --control-hover-line: #58b8ff;
  --pill-bg: #132c42; --pill-ink: #c3d7ef; --pill-line: #28465f;
  --hover: #132c42; --green: #36dfad; --amber: #ffce58; --red: #ff6d80;
  --attention-bg: #221b2c; --ok-bg: #063127; --ok-line: #146348;
  --warn-bg: #302714; --warn-line: #796024; --bad-bg: #341e2b; --bad-line: #783147;
  color-scheme: dark; color: var(--ink); background: var(--bg);
}
:root {
  --mc-ambient: #11345b66;
  --mc-nav-start: #0b2949;
  --mc-nav-border: #265585;
  --mc-cyan: #4ccaff;
  --mc-primary-bright: #1263db;
  --mc-primary-edge: #4197ff;
  --mc-command-ambient: #12508955;
  --mc-icon-blue-bg: #1262bf33;
  --mc-icon-blue: #59baff;
  --mc-icon-green-bg: #10a58126;
  --mc-icon-red-bg: #ff406526;
  --mc-icon-amber-bg: #ffb92f26;
  --mc-violet: #bd9aff;
  --mc-icon-violet-bg: #8c55ff26;
  --mc-board-wash: #708aa20a;
  --mc-failure-wash: #ff57710b;
  --mc-approval-wash: #ffce580b;
  --mc-policy-ink: #d4b7ff;
  --mc-policy-bg: #482d6929;
  --mc-policy-line: #705099;
  --mc-avatar-bg: #19394e;
  --mc-alert-bg: #ff557d33;
  --mc-pipeline-arrow: #6488ac;
  --mc-stage-bg: #0085ff16;
  --mc-violet-strong: #ac86ff;
  --mc-chart-start: #499fff;
  --mc-chart-complete: #30dfb0;
  --mc-chart-fail: #ff6d80;
  --mc-chart-label: #6abaff;
  --mc-drawer-overlay: #0007;
  --mc-search-shadow: #0008;
}
.ui-icon { width: 21px; height: 21px; display: inline-block; vertical-align: middle; } .metric-icon .ui-icon { width: 25px; height: 25px; }
body { background: radial-gradient(ellipse at 60% -15%, var(--mc-ambient), transparent 65%), var(--bg); grid-template-columns: 218px minmax(0, 1fr); font-size: 13px; }
aside { box-sizing: border-box; padding: 18px 10px; background: linear-gradient(150deg, var(--side), var(--bg)); height: 100dvh; overflow-y: auto; z-index: 5; }
.brand { display: flex; gap: 12px; align-items: center; padding: 0 10px 20px; border-bottom: 1px solid var(--soft-line); font-size: 21px; letter-spacing: .02em; }
.brand span { font-size: 12px; font-weight: 500; letter-spacing: 0; margin-top: 3px; }
nav { margin-top: 18px; gap: 5px; }
nav a { min-height: 43px; padding: 0 15px; display: flex; gap: 16px; align-items: center; border: 1px solid transparent; border-radius: 7px; font-weight: 500; }
nav a.active { background: linear-gradient(100deg,var(--mc-nav-start),var(--nav-active)); border-color: var(--mc-nav-border); box-shadow: inset 2px 0 var(--mc-cyan); }
.nav-icon { width: 18px; font-size: 21px; text-align: center; line-height: 1; }
.rail-note { margin: 35px 10px 12px; padding-top: 18px; border-top: 1px solid var(--line); font-size: 11px; line-height: 1.65; }
main { padding: 18px 20px 32px; }
header { min-height: 70px; border-bottom: 1px solid var(--line); padding-bottom: 15px; align-items: center; gap: 20px; }
h1 { font-size: 27px; letter-spacing: -.02em; line-height: 1.2; margin: 0 0 5px; }
h2 { font-size: 16px; letter-spacing: -.01em; } h3 { font-size: 13px; }
.page-heading p { font-size: 13px; max-width: 650px; }
.header-controls { align-items: center; gap: 13px; flex-wrap: wrap; justify-content: end; }
.global-search { display: flex; gap: 8px; align-items: center; border: 1px solid var(--control-line); border-radius: 8px; background: var(--control-bg); padding: 6px 10px; width: 240px; }
.global-search input { border: 0; background: transparent; padding: 3px; min-width: 0; font-size: 11px; box-shadow: none; }
.global-search kbd { font-size: 10px; white-space: nowrap; }
.execution-mode { display: flex; flex-wrap: wrap; min-width: 190px; max-width: none; gap: 5px 9px; border: 1px solid var(--line); border-radius: 8px; padding: 5px 10px; font-size: 11px; }
.execution-mode legend { font-size: 10px; color: var(--muted); } .execution-mode label { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; margin: 0; } .execution-mode input { width: auto; margin: 0; } .execution-mode p:empty { display: none; }
.header-tools button { padding: 3px 6px; font-size: 10px; min-height: 27px; }
.live { font-size: 11px; max-width: 200px; white-space: normal; } .dashboard-updated { font-size: 10px; }
.page-actions { display: flex; gap: 8px; align-items: center; justify-content: end; margin: 0 0 12px; }
.page-actions .muted { margin-right: auto; order: -1; font-size: 11px; }
button, input, select, textarea { border-radius: 6px; font: inherit; }
button { border-color: var(--control-line); } button:hover { border-color: var(--accent); }
.approval-actions [data-approve] .hash-prefix { color: inherit; opacity: 1; }
.primary-button, .approval-actions [data-approve] { background: var(--mc-primary-bright); color: white; border: 1px solid var(--mc-primary-edge); padding: 8px 15px; }
button { background-color: var(--control-bg); color: var(--ink); border: 1px solid var(--control-line); }
.card, .panel, .section-card, .command-summary { border: 1px solid var(--line); background: linear-gradient(130deg,var(--surface),var(--bg)); border-radius: 11px; box-shadow: none; overflow: hidden; min-width: 0; }
.panel-head { border-bottom: 1px solid var(--soft-line); padding: 13px 15px; background: transparent; }
.panel-head a { color: var(--accent); font-size: 11px; white-space: nowrap; text-decoration: none; }
.panel-head p { margin: 4px 0 0; color: var(--muted); }
.section-card { margin-bottom: 13px; } .empty { padding: 16px; font-size: 12px; line-height: 1.6; }
.eyebrow { font-size: 10px; color: var(--muted); letter-spacing: .07em; }
.command-summary { margin-bottom: 14px; background: radial-gradient(ellipse at 80% 0%,var(--mc-command-ambient),transparent 60%),var(--surface); }
.metric-grid { display: grid; grid-template-columns: repeat(5,minmax(0,1fr)); gap: 12px; margin: 0 0 14px; }
.metric-card { border: 1px solid var(--line); border-radius: 10px; padding: 15px 12px; display: flex; gap: 13px; min-width: 0; background: linear-gradient(130deg,var(--surface-2),var(--surface)); align-items: start; }
.metric-card strong { display: block; font-size: 27px; font-weight: 650; line-height: 1.2; letter-spacing: -.03em; }
.metric-card span:not(.metric-icon) { display: block; font-size: 12px; margin-top: 4px; }
.metric-card small { display: block; color: var(--muted); font-size: 10px; margin-top: 10px; line-height: 1.5; }
.metric-icon { font-variant-emoji: text; border-radius: 13px; background: var(--mc-icon-blue-bg); color: var(--mc-icon-blue); width: 43px; height: 43px; display: grid; place-items: center; font-size: 24px; flex-shrink: 0; }
.green .metric-icon { font-variant-emoji: text; color: var(--green); background: var(--mc-icon-green-bg); } .red .metric-icon { font-variant-emoji: text; color: var(--red); background: var(--mc-icon-red-bg); } .amber .metric-icon { font-variant-emoji: text; color: var(--amber); background: var(--mc-icon-amber-bg); } .violet .metric-icon { font-variant-emoji: text; color: var(--mc-violet); background: var(--mc-icon-violet-bg); }
.command-metrics { grid-template-columns: repeat(4,minmax(0,1fr)); margin: 0; padding: 12px 6px 17px; }
.command-metrics .metric-card { border: 0; border-right: 1px solid var(--line); border-radius: 0; background: transparent; padding: 12px; }
.command-metrics .metric-card:last-child { border-right: 0; }
.operations-layout { display: grid; grid-template-columns: minmax(0,1fr) minmax(280px, .37fr); gap: 14px; }
.operations-main, .operations-rail { min-width: 0; }
.overview-bottom { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 14px; }
.mission-board { display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); gap: 10px; padding: 11px; }
.board-column { border: 1px solid var(--line); border-radius: 10px; background: var(--mc-board-wash); padding: 8px; min-width: 0; max-height: 400px; overflow-y: auto; }
.board-column h3 { display: flex; gap: 8px; align-items: center; margin: 3px 0 12px; white-space: nowrap; font-size: 11px; }
.board-column h3 span { font-size: 10px; padding: 2px 6px; border-radius: 12px; background: var(--surface-2); color: var(--muted); }
.board-column h3 i, .health-dot { border-radius: 50%; width: 10px; height: 10px; display: inline-block; background: var(--accent); }
.board-column.green h3 i, .health-dot.green { background: var(--green); } .board-column.amber h3 i { background: var(--amber); } .board-column.red h3 i, .health-dot.red { background: var(--red); }
.mission-card { display: block; width: 100%; text-align: left; padding: 10px; margin-bottom: 8px; background: linear-gradient(140deg,var(--surface-2),var(--surface)); border: 1px solid var(--line); border-radius: 8px; color: var(--ink); min-width: 0; }
.mission-card strong { font-size: 11px; font-weight: 600; display: block; line-height: 1.5; }
.mission-card small { font-size: 9px; color: var(--accent); display: block; overflow-wrap: anywhere; margin-top: 3px; }
.mission-card p { font-size: 10px; color: var(--muted); line-height: 1.4; margin: 5px 0 8px; overflow-wrap: anywhere; }
.mission-card footer { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 5px; font-size: 9px; color: var(--muted); margin-top: 10px; overflow-wrap: anywhere; }
.board-column.red .mission-card { background: var(--mc-failure-wash); } .board-column.amber .mission-card { background: var(--mc-approval-wash); }
.pill { font-size: 10px; padding: 3px 8px; border-radius: 14px; } .pill.pending_policy { color: var(--mc-policy-ink); background: var(--mc-policy-bg); border-color: var(--mc-policy-line); }
.rail-list { padding: 0 14px; } .health-row, .failure-row { display: flex; align-items: center; gap: 9px; padding: 12px 0; border-bottom: 1px solid var(--soft-line); min-width: 0; color: var(--ink); text-decoration: none; }
.health-row > span:nth-child(2), .failure-row > div { flex: 1; min-width: 0; }
.health-row strong, .failure-row strong { font-size: 11px; display: block; overflow-wrap: anywhere; } .health-row small, .failure-row small { font-size: 10px; color: var(--muted); display: block; line-height: 1.5; margin-top: 3px; overflow-wrap: anywhere; }
.health-row .agent-avatar { width: 25px; height: 25px; font-size: 12px; border: 1px solid var(--line); background: var(--mc-avatar-bg); }
.failure-icon { width: 20px; height: 20px; border-radius: 50%; display: grid; place-items: center; background: var(--mc-alert-bg); color: var(--red); }
.failure-row button { font-size: 10px; padding: 5px 7px; white-space: nowrap; }
.approval-preview { width: 100%; padding: 13px 0; border: 0; border-bottom: 1px solid var(--line); border-radius: 0; background: transparent; text-align: left; }
.approval-preview strong, .approval-preview small, .approval-preview span { display: block; } .approval-preview strong { font-size: 12px; } .approval-preview small { font-size: 10px; margin-top: 6px; color: var(--muted); } .approval-preview span { color: var(--accent); font-size: 10px; margin-top: 8px; }
.system-check-grid { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 10px; padding: 14px; }
.system-check-grid > div { border: 1px solid var(--line); border-radius: 7px; padding: 10px; font-size: 11px; }
.system-check-grid strong { margin-left: 7px; font-weight: 500; overflow-wrap: anywhere; } .system-check-grid small { display: block; color: var(--muted); margin-top: 8px; }
.execution-pipeline { display: grid; grid-template-columns: repeat(7,minmax(0,1fr)); padding: 20px 10px 8px; gap: 9px; }
.pipeline-stage { position: relative; text-decoration: none; color: var(--ink); display: grid; place-items: center; gap: 9px; text-align: center; }
.pipeline-stage:not(:last-child)::after { content: '→'; position: absolute; top: 16px; right: -12px; color: var(--mc-pipeline-arrow); }
.stage-icon { display: grid; place-items: center; width: 44px; height: 44px; border: 2px solid var(--accent); background: var(--mc-stage-bg); border-radius: 50%; font-size: 23px; color: var(--accent); }
.green .stage-icon { border-color: var(--green); color: var(--green); } .amber .stage-icon { border-color: var(--amber); color: var(--amber); } .red .stage-icon { border-color: var(--red); color: var(--red); } .violet .stage-icon { border-color: var(--mc-violet-strong); color: var(--mc-violet-strong); }
.pipeline-stage strong { font-size: 10px; font-weight: 500; } .pipeline-stage b { font-size: 18px; }
.panel-note { padding: 6px 15px 12px; color: var(--muted); font-size: 10px; line-height: 1.5; }
.execution-filter, .audit-filters { display: flex; align-items: end; gap: 12px; padding: 12px 15px; border-bottom: 1px solid var(--line); }
.execution-filter label, .audit-filters label { display: grid; gap: 6px; font-size: 11px; color: var(--muted); }
.execution-filter input, .audit-filters input { width: 230px; } .execution-filter select { min-width: 150px; }
.section-card:has(.runs-table) .table-wrap { max-height: 440px; }
.table-wrap { overflow: auto; max-height: 680px; } table { border-collapse: collapse; width: 100%; font-size: 11px; } th { padding: 10px 13px; text-align: left; color: var(--muted); font-size: 10px; font-weight: 500; background: var(--surface); position: sticky; top: 0; } td { border-top: 1px solid var(--soft-line); padding: 9px 13px; overflow-wrap: anywhere; }
.runs-table td:first-child { min-width: 180px; color: var(--accent); } td strong, td small { display: block; } td strong { font-weight: 500; } td small { color: var(--muted); margin-top: 3px; } td button { font-size: 10px; padding: 5px 8px; }
.chart-wrap { padding: 10px 14px; } .chart-wrap svg { width: 100%; height: auto; max-height: 200px; } .chart-grid { stroke: var(--line); fill: none; } .chart-0 { fill: var(--mc-chart-start); } .chart-1 { fill: var(--mc-chart-complete); } .chart-2 { fill: var(--mc-chart-fail); } svg text { fill: var(--muted); font-size: 10px; }
.chart-legend { display: flex; justify-content: end; gap: 18px; font-size: 10px; } .chart-legend span:nth-child(1) { color: var(--mc-chart-label); } .chart-legend span:nth-child(2) { color: var(--green); } .chart-legend span:nth-child(3) { color: var(--red); } .chart-wrap summary { color: var(--muted); font-size: 10px; cursor: pointer; padding: 8px 0; }
.admission-meter { padding: 18px; } .admission-meter > div { display: flex; justify-content: space-between; margin-bottom: 12px; } .admission-meter span, .admission-meter p, .admission-meter a, .admission-meter small { font-size: 11px; color: var(--muted); } .admission-meter small { display: block; margin-top: 10px; } progress { width: 100%; accent-color: var(--accent); height: 8px; }
.approval-metrics { grid-template-columns: repeat(4,minmax(0,1fr)); } .capability-coverage { padding: 12px 16px; } .capability-coverage div { display: flex; justify-content: space-between; border-bottom: 1px solid var(--line); padding: 10px 0; font-size: 11px; }
.overview-bottom .timeline, .operations-rail .timeline { max-height: 275px; overflow-y: auto; }
.activity-timeline { list-style: none; padding: 8px 15px; margin: 0; max-height: 250px; overflow-y: auto; } .activity-timeline li { display: flex; align-items: center; gap: 10px; padding: 10px 0; border-bottom: 1px solid var(--soft-line); } .activity-timeline li > div { flex: 1; min-width: 0; } .activity-timeline strong, .activity-timeline small, .activity-timeline time { display: block; font-size: 11px; line-height: 1.5; overflow-wrap: anywhere; } .activity-timeline small, .activity-timeline time { color: var(--muted); font-size: 10px; } .activity-timeline button { font-size: 10px; padding: 4px 6px; } .activity-marker { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); flex-shrink: 0; }
.timeline { padding: 12px 15px; } .timeline li { padding: 9px 0; font-size: 11px; } .timeline time { font-size: 10px; color: var(--muted); } .timeline strong { font-size: 11px; font-weight: 500; } .event-attrs { font-size: 10px; }
.grid { grid-template-columns: minmax(0,1fr); } .grid:has(> [data-view-panel]) { margin-bottom: 0; } .grid > [data-view-panel] { margin-bottom: 14px; } .lower { grid-template-columns: minmax(0,1fr); }
.cards { grid-template-columns: repeat(7,minmax(0,1fr)); gap: 8px; } .card { padding: 12px; } .card strong { font-size: 21px; } .card > span { font-size: 9px; } .card p { font-size: 10px; } .card-action { font-size: 10px; }
.agent-card-grid { grid-template-columns: repeat(3,minmax(0,1fr)); } .agent-card { border-radius: 10px; background: linear-gradient(130deg,var(--surface-2),var(--surface)); } .agent-layout { grid-template-columns: minmax(0,1fr) minmax(260px,.45fr); }
.queue-filter { gap: 7px; } .queue-filter-chip { font-size: 10px; padding: 4px 8px; } .queue-item { display: grid; grid-template-columns: 220px minmax(130px,1fr) minmax(120px,.7fr); gap: 7px 14px; align-items: center; } .queue-item > small { font-size: 11px; } .queue-item strong { font-size: 13px; }
.entity-drawer { position: fixed; z-index: 25; inset: 0 0 0 auto; width: min(640px,100vw); background: var(--surface); border-left: 1px solid var(--control-line); box-shadow: -100vw 0 0 100vw var(--mc-drawer-overlay); overflow-y: auto; padding: 0 8px 15px; box-sizing: border-box; }
.entity-drawer[hidden] { display: none; } .drawer-head { position: sticky; top: 0; z-index: 1; background: var(--surface); padding: 15px; border-bottom: 1px solid var(--line); display: flex; justify-content: space-between; align-items: center; } .drawer-head button { font-size: 22px; min-width: 35px; } .entity-drawer .detail-panel { max-height: none; margin: 8px; border: 0; padding: 14px; background: transparent; }
.command-results { position: fixed; z-index: 30; top: 85px; right: 20px; width: min(520px,calc(100vw - 40px)); max-height: 65vh; overflow-y: auto; background: var(--surface); border: 1px solid var(--control-line); border-radius: 10px; box-shadow: 0 20px 60px var(--mc-search-shadow); padding: 10px; }
.command-results button { display: block; width: 100%; text-align: left; padding: 10px; margin-bottom: 5px; } .command-results small { display: block; color: var(--muted); font-size: 10px; margin-top: 4px; }
.admin-mode-banner { padding: 7px 12px; font-size: 11px; border-radius: 6px; margin-bottom: 10px; }
.action-status:empty { display: none; } :focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
@media (max-width: 1250px) { .operations-layout { grid-template-columns: minmax(0,1fr); } .operations-rail { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 12px; } .metric-card { gap: 8px; } .metric-icon { font-variant-emoji: text; width: 32px; height: 32px; font-size: 20px; } .metric-card strong { font-size: 23px; } .global-search { width: 180px; } .cards { grid-template-columns: repeat(4,minmax(0,1fr)); } }
@media (max-width: 1000px) { body { grid-template-columns: 180px minmax(0,1fr); } nav a { padding: 0 8px; gap: 10px; } main { padding: 15px; } header { align-items: start; flex-direction: column; } .header-controls { justify-content: start; } .agent-card-grid { grid-template-columns: repeat(2,minmax(0,1fr)); } .agent-layout { grid-template-columns: 1fr; } .metric-grid { grid-template-columns: repeat(3,minmax(0,1fr)); } .command-metrics { grid-template-columns: repeat(2,minmax(0,1fr)); } .mission-board { grid-template-columns: repeat(2,minmax(0,1fr)); } .operations-rail { grid-template-columns: 1fr; } }
@media (max-width: 767px) { body { display: block; } aside { position: static; height: auto; padding: 10px; } .brand { padding-bottom: 10px; } nav { display: flex; overflow-x: auto; margin-top: 10px; } nav a { flex-shrink: 0; min-height: 44px; } .rail-note { display: none; } main { padding: 12px; } .header-controls { width: 100%; } .global-search { width: 100%; } .metric-grid, .command-metrics { grid-template-columns: repeat(2,minmax(0,1fr)); } .overview-bottom { grid-template-columns: 1fr; } .mission-board { grid-template-columns: 1fr; } .execution-pipeline { overflow-x: auto; grid-template-columns: repeat(7,90px); } .execution-filter, .audit-filters { flex-wrap: wrap; } .execution-filter input, .audit-filters input { width: 100%; } .queue-item { grid-template-columns: 1fr; } .cards { grid-template-columns: repeat(2,minmax(0,1fr)); } .agent-card-grid { grid-template-columns: 1fr; } button, input, select { min-height: 44px; } .system-panel { grid-template-columns: 1fr; } .runs-table { min-width: 760px; } .command-metrics .metric-card { border: 0; } .eyebrow { display: none; } }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; scroll-behavior: auto !important; } }
`;
}
