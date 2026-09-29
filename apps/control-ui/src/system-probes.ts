/**
 * Periodic readiness probing for the System panel. Probes run only while the
 * System view is open and the tab is visible, keep a short history, and flag
 * a degraded gateway (non-2xx, unreachable, or slow).
 */

export const PROBE_PATH = "/readyz";
export const PROBE_INTERVAL_MS = 20_000;
export const PROBE_HISTORY = 10;
/** A single probe slower than this is flagged as slow. */
export const PROBE_SLOW_MS = 1_000;

/** Relies on the dashboard client's `announce`. */
export function systemProbesClientSource(): string {
  return `
const probeHistory = [];
let probeTimer = null;
let probeInFlight = false;
let lastProbeHealthy = null;

async function probePath(path) {
  const started = performance.now();
  try {
    const res = await fetch(path, { headers: { accept: 'application/json' }, cache: 'no-store' });
    const rttMs = Math.max(0, performance.now() - started);
    let body = {};
    try { body = await res.json(); } catch {}
    const headerMs = Number(res.headers && res.headers.get ? res.headers.get('x-acs-readyz-ms') : NaN);
    const bodyMs = Number(body && body.telemetry ? body.telemetry.latestMs : NaN);
    const gatewayMs = Number.isFinite(bodyMs) ? bodyMs : Number.isFinite(headerMs) ? headerMs : null;
    return {
      path,
      status: res.status,
      ms: rttMs,
      gatewayMs,
      telemetry: body && body.telemetry ? body.telemetry : null,
      deepHealth: body && body.deepHealth ? body.deepHealth : null,
      payload: body,
      at: Date.now()
    };
  } catch {
    return {
      path,
      status: 0,
      ms: Math.max(0, performance.now() - started),
      gatewayMs: null,
      telemetry: null,
      deepHealth: null,
      at: Date.now()
    };
  }
}

function probeHealthy(row) {
  return row.status >= 200 && row.status < 300;
}

function formatProbeMs(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  return (number < 10 ? number.toFixed(2) : Math.round(number).toString()) + 'ms';
}

function renderProbes() {
  const root = document.querySelector('#system-probes');
  if (!root || !probeHistory.length) return;
  const latest = probeHistory[probeHistory.length - 1];
  const localFailures = probeHistory.filter(function (row) { return row.status < 200 || row.status >= 300; }).length;
  const telemetry = latest.telemetry || null;
  const failures = telemetry ? Number(telemetry.failures || 0) : localFailures;
  const sampleCount = telemetry ? Number(telemetry.sampleCount || 0) : probeHistory.length;
  const state = latest.status === 0 ? 'down' : latest.status >= 300 ? 'failing' : latest.ms >= ${PROBE_SLOW_MS} ? 'slow' : 'ok';
  const readiness = latest.status === 0 ? 'unreachable' : latest.status >= 300 ? 'failing' : 'healthy';
  const deep = latest.deepHealth;
  const deepLabel = deep
    ? (deep.ok ? 'healthy' : 'unhealthy') + ' · ' + new Date(deep.checkedAt).toLocaleTimeString() + (deep.source ? ' · ' + deep.source : '')
    : 'not checked';
  root.dataset.state = state;
  const payload = latest.payload && typeof latest.payload === 'object' ? latest.payload : {};
  const checks = payload.checks && typeof payload.checks === 'object' ? payload.checks : {};
  const checkNames = Object.keys(checks);
  const failedChecks = checkNames.filter(function (name) { return !checks[name] || checks[name].ok !== true; });
  const execution = payload.execution && typeof payload.execution === 'object' ? payload.execution : null;
  const rows = [
    ['Browser RTT', formatProbeMs(latest.ms)],
    ['Gateway', formatProbeMs(latest.gatewayMs)],
    ['p50 gateway', formatProbeMs(telemetry && telemetry.p50Ms)],
    ['p95 gateway', formatProbeMs(telemetry && telemetry.p95Ms)],
    ['Readiness', readiness],
    ['Dependency checks', checkNames.length ? (failedChecks.length ? 'failed: ' + failedChecks.join(', ') : checkNames.length + ' passing') : '—'],
    ['Execution admission', execution ? String(execution.active) + ' / ' + String(execution.capacity) + ' active · ' + String(execution.queued) + ' queued' + (execution.saturated ? ' · saturated' : '') : '—'],
    ['Failures', String(failures) + ' / ' + String(sampleCount)],
    ['Deep health', deepLabel],
    ['Last checked', new Date(latest.at).toLocaleTimeString()]
  ];
  const list = document.createElement('dl');
  rows.forEach(function (row) {
    const item = document.createElement('div');
    const term = document.createElement('dt');
    const value = document.createElement('dd');
    term.textContent = row[0];
    value.textContent = row[1];
    item.append(term, value);
    list.append(item);
  });
  const trend = document.createElement('p');
  trend.className = 'probe-trend';
  trend.setAttribute('aria-label', 'Recent probe results, oldest first');
  trend.textContent = probeHistory.map(function (row) { return probeHealthy(row) ? '▮' : '▯'; }).join('');
  root.replaceChildren(list, trend);
}

async function runSystemProbe() {
  if (probeInFlight) return;
  probeInFlight = true;
  try {
    const row = await probePath('${PROBE_PATH}');
    probeHistory.push(row);
    while (probeHistory.length > ${PROBE_HISTORY}) probeHistory.shift();
    const healthy = probeHealthy(row);
    if (lastProbeHealthy !== null && healthy !== lastProbeHealthy) {
      announce(healthy ? 'Gateway readiness recovered' : 'Gateway readiness degraded');
    }
    lastProbeHealthy = healthy;
    renderProbes();
  } finally {
    probeInFlight = false;
  }
}

function syncSystemProbes() {
  const active = document.body.dataset.activeView === 'system' && document.visibilityState !== 'hidden';
  if (active && !probeTimer) {
    void runSystemProbe();
    probeTimer = setInterval(function () { void runSystemProbe(); }, ${PROBE_INTERVAL_MS});
  } else if (!active && probeTimer) {
    clearInterval(probeTimer);
    probeTimer = null;
  }
}

document.addEventListener('visibilitychange', syncSystemProbes);
`;
}
