/** A stale approval must refresh the displayed hash and must not submit that new hash automatically. */
export function codingMissionApprovalDecision(status: number): "refresh" | "accepted" | "show_error" {
  if (status === 409) return "refresh";
  if (status >= 200 && status < 300) return "accepted";
  return "show_error";
}

export function codingMissionPanelSource(): string {
  return `
const codingMissionDecision = ${codingMissionApprovalDecision.toString()};
let codingMissionTimer = null;

function codingMissionEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, function (character) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character];
  });
}

function codingMissionLabel(mission) {
  if (mission.state === 'WAITING_FOR_APPROVAL') return 'waiting';
  if (mission.state === 'EXECUTING') return mission.deploymentRequired ? 'Merging / deploying' : 'Merging';
  if (mission.state === 'VERIFYING') return 'Verifying';
  if (mission.state === 'COMPLETED') return 'Complete';
  return codingMissionEscape(mission.state || 'unknown');
}

function codingMissionCard(mission) {
  const hash = typeof mission.changeSet === 'string' ? mission.changeSet : '';
  const files = Array.isArray(mission.files) ? mission.files : [];
  const checks = mission.checks && typeof mission.checks === 'object' ? mission.checks : {};
  const pull = mission.pullRequest || {};
  const checkText = Object.keys(checks).map(function (name) {
    return '<li><span>' + codingMissionEscape(name) + '</span> <strong>' + codingMissionEscape(checks[name]) + '</strong></li>';
  }).join('');
  const fileText = files.map(function (file) {
    return '<li><code>' + codingMissionEscape(file) + '</code></li>';
  }).join('');
  const pullText = pull.url
    ? '<a href="' + codingMissionEscape(pull.url) + '" rel="noreferrer">' + codingMissionEscape(pull.number ? '#' + pull.number : pull.url) + '</a>'
    : (pull.number ? '#' + codingMissionEscape(pull.number) : 'none');
  const approve = mission.state === 'WAITING_FOR_APPROVAL' && /^[a-f0-9]{64}$/.test(hash)
    ? '<button type="button" class="primary-button" data-approve-change-set data-mission-id="' + codingMissionEscape(mission.missionId) + '" data-change-set-hash="' + codingMissionEscape(hash) + '">Approve change set</button>'
    : '';
  return '<article class="coding-mission"><p><strong>' + codingMissionEscape(mission.summary || mission.missionId) + '</strong> <span>' + codingMissionLabel(mission) + '</span></p>'
    + '<p>Change set <code>' + codingMissionEscape(hash || 'unavailable') + '</code></p>'
    + '<p>Pull request ' + pullText + '</p>'
    + '<p>Deployment ' + codingMissionEscape(mission.deploymentRequired ? 'required' : 'not required') + ': ' + codingMissionEscape(mission.deploymentImpact || '') + '</p>'
    + '<ul>' + (checkText || '<li>No validation result</li>') + '</ul>'
    + '<ul>' + (fileText || '<li>No proposed mutations</li>') + '</ul>'
    + approve + '</article>';
}

async function refreshCodingMissions() {
  const root = document.getElementById('coding-mission-list');
  if (!root) return;
  let payload = null;
  try {
    const response = await fetch('/coding-missions', { credentials: 'same-origin', headers: { accept: 'application/json' } });
    if (!response.ok) {
      root.innerHTML = '<p class="empty">Coding missions are unavailable.</p>';
      return;
    }
    payload = await response.json();
  } catch (error) {
    root.innerHTML = '<p class="empty">Coding missions are unavailable.</p>';
    return;
  }
  const missions = payload && Array.isArray(payload.missions) ? payload.missions : [];
  root.innerHTML = missions.length
    ? '<p id="coding-mission-note" class="muted"></p>' + missions.map(codingMissionCard).join('')
    : '<p class="empty">No coding missions are waiting for approval.</p>';
  const pending = missions.some(function (mission) {
    return mission.state !== 'COMPLETED' && mission.state !== 'FAILED' && mission.state !== 'DEGRADED';
  });
  if (pending && !codingMissionTimer) codingMissionTimer = setInterval(refreshCodingMissions, 4000);
  if (!pending && codingMissionTimer) {
    clearInterval(codingMissionTimer);
    codingMissionTimer = null;
  }
}

document.addEventListener('click', async function (event) {
  const button = event.target && event.target.closest ? event.target.closest('[data-approve-change-set]') : null;
  if (!button || button.disabled) return;
  const missionId = button.getAttribute('data-mission-id');
  const hash = button.getAttribute('data-change-set-hash');
  const displayed = button.parentElement ? button.parentElement.querySelector('code') : null;
  if (!missionId || !hash || !displayed || displayed.textContent !== hash) return;
  button.disabled = true;
  const response = await fetch('/coding-missions/' + encodeURIComponent(missionId) + '/approve', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ expectedChangeSetHash: hash })
  });
  const decision = codingMissionDecision(response.status);
  if (decision === 'refresh') {
    const note = document.getElementById('coding-mission-note');
    if (note) note.textContent = 'This change set changed. Refreshing the proposal.';
    await refreshCodingMissions();
    const refreshed = document.getElementById('coding-mission-note');
    if (refreshed) refreshed.textContent = 'This change set changed. Refreshing the proposal.';
    return;
  }
  await refreshCodingMissions();
});

refreshCodingMissions();
`;
}
