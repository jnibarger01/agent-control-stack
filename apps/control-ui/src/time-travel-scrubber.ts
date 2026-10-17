/**
 * Read-only mission replay mounted under "Recent Events".
 *
 * The scrubber calls GET /dashboard/missions/:id/time-travel, which returns the
 * full-chain-verified audit projection as of a chosen sequence. It is injected
 * at runtime so the server-rendered dashboard markup (and its golden files)
 * stays unchanged. All API data is written with textContent only; the snapshot
 * carries digests and event names, never raw attributes or command bodies.
 */

/** Default event page for a replay request. The server caps a page at 2000. */
export const TIME_TRAVEL_DEFAULT_EVENTS = 200;

/** Relies on the dashboard client's `fetchJson` and `announce`, and the optional `selectedWorkItemId`. */
export function timeTravelScrubberClientSource(): string {
  return `
let timeTravelRequestId = 0;

function timeTravelUrl(missionId, asOfSequence) {
  let url = '/dashboard/missions/' + encodeURIComponent(missionId) + '/time-travel?maxEvents=${TIME_TRAVEL_DEFAULT_EVENTS}';
  if (asOfSequence !== null) url += '&asOfSequence=' + encodeURIComponent(String(asOfSequence));
  return url;
}

function mountTimeTravelScrubber() {
  const host = document.getElementById('events');
  if (!host || document.getElementById('time-travel')) return;

  const section = document.createElement('section');
  section.id = 'time-travel';
  section.setAttribute('aria-label', 'Mission replay, read-only');

  const heading = document.createElement('h3');
  heading.textContent = 'Mission replay';
  const note = document.createElement('p');
  note.className = 'muted';
  note.textContent = 'Read-only. Replays the verified audit projection. Nothing here executes or authorizes past actions.';

  const idLabel = document.createElement('label');
  idLabel.textContent = 'Mission ID ';
  const idInput = document.createElement('input');
  idInput.type = 'text';
  idInput.maxLength = 128;
  idInput.pattern = '[A-Za-z0-9._:-]{1,128}';
  idInput.autocomplete = 'off';
  idInput.value = (typeof selectedWorkItemId !== 'undefined' && selectedWorkItemId) ? selectedWorkItemId : '';
  idLabel.appendChild(idInput);

  const loadButton = document.createElement('button');
  loadButton.type = 'button';
  loadButton.className = 'tool-button';
  loadButton.textContent = 'Replay latest';

  const seqLabel = document.createElement('label');
  seqLabel.textContent = 'As of sequence ';
  const range = document.createElement('input');
  range.type = 'range';
  range.min = '0';
  range.max = '0';
  range.value = '0';
  range.disabled = true;
  const seqValue = document.createElement('span');
  seqValue.textContent = 'latest';
  seqLabel.append(range, ' ', seqValue);

  const status = document.createElement('p');
  status.className = 'muted';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const list = document.createElement('ol');
  list.className = 'timeline';
  list.setAttribute('aria-label', 'Replayed events, oldest first');

  section.append(heading, note, idLabel, ' ', loadButton, seqLabel, status, list);
  host.appendChild(section);

  let asOfSequence = null;
  let headSequence = 0;
  let activeId = '';

  function renderEvents(snapshot) {
    list.replaceChildren();
    snapshot.events.forEach(function (event) {
      const item = document.createElement('li');
      item.dataset.sequence = String(event.sequence);
      const time = document.createElement('time');
      const nanos = Number(event.timeUnixNano);
      time.textContent = Number.isFinite(nanos) ? new Date(Math.floor(nanos / 1000000)).toLocaleString() : '';
      const name = document.createElement('strong');
      name.textContent = event.name;
      const category = document.createElement('span');
      category.className = 'muted';
      category.textContent = ' [' + event.category + ']';
      item.append(time, ' ', name, category);
      list.appendChild(item);
    });
  }

  function renderStatus(snapshot) {
    const hash = typeof snapshot.snapshotHash === 'string' ? snapshot.snapshotHash.slice(0, 12) : '';
    const where = asOfSequence === null ? 'latest' : 'as of sequence ' + asOfSequence;
    status.textContent = 'Verified full chain, ' + snapshot.events.length + ' events, ' + where +
      (hash ? ', snapshot ' + hash : '');
  }

  async function replay(missionId, sequence) {
    const requestId = ++timeTravelRequestId;
    loadButton.disabled = true;
    status.textContent = 'Replaying';
    try {
      const snapshot = await fetchJson(timeTravelUrl(missionId, sequence));
      if (requestId !== timeTravelRequestId) return;
      activeId = missionId;
      const events = Array.isArray(snapshot.events) ? snapshot.events : [];
      if (sequence === null) {
        // Latest replay sets the scrubber bounds to the mission's own event sequences.
        headSequence = events.length ? events[events.length - 1].sequence : 0;
        range.min = '0';
        range.max = String(headSequence);
        range.value = String(headSequence);
        range.disabled = headSequence === 0;
        seqValue.textContent = 'latest';
      }
      renderEvents({ events: events });
      renderStatus({ events: events, snapshotHash: snapshot.snapshotHash });
      announce('Replay loaded, ' + events.length + ' events');
    } catch (error) {
      if (requestId !== timeTravelRequestId) return;
      status.textContent = 'Replay failed: ' + ((error && error.message) || 'unknown error');
      list.replaceChildren();
      announce('Replay failed');
    } finally {
      if (requestId === timeTravelRequestId) loadButton.disabled = false;
    }
  }

  loadButton.addEventListener('click', function () {
    const missionId = idInput.value.trim();
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(missionId)) {
      status.textContent = 'Enter a mission ID using letters, digits, and . _ : - (max 128).';
      return;
    }
    asOfSequence = null;
    void replay(missionId, null);
  });

  range.addEventListener('input', function () {
    seqValue.textContent = range.value;
  });

  range.addEventListener('change', function () {
    if (!activeId) return;
    asOfSequence = Number(range.value);
    void replay(activeId, asOfSequence);
  });
}

mountTimeTravelScrubber();
`;
}
