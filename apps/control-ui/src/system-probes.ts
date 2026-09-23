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
    return { path, status: res.status, ms: Math.round(performance.now() - started), at: Date.now() };
  } catch {
    return { path, status: 0, ms: Math.round(performance.now() - started), at: Date.now() };
  }
}

function probeHealthy(row) {
  return row.status >= 200 && row.status < 300 && row.ms < ${PROBE_SLOW_MS};
}

function renderProbes() {
  const root = document.querySelector('#system-probes');
  if (!root || !probeHistory.length) return;
  const latest = probeHistory[probeHistory.length - 1];
  const okRows = probeHistory.filter(function (row) { return row.status >= 200 && row.status < 300; });
  const avg = okRows.length ? Math.round(okRows.reduce(function (sum, row) { return sum + row.ms; }, 0) / okRows.length) : null;
  const failures = probeHistory.length - okRows.length;
  const state = latest.status === 0 ? 'down' : latest.status >= 300 ? 'failing' : latest.ms >= ${PROBE_SLOW_MS} ? 'slow' : 'ok';
  root.dataset.state = state;
  const rows = [
    ['${PROBE_PATH}', (latest.status || 'unreachable') + ' · ' + latest.ms + 'ms · ' + state],
    ['Average (ok, last ' + probeHistory.length + ')', avg === null ? '—' : avg + 'ms'],
    ['Failures (last ' + probeHistory.length + ')', String(failures)],
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
