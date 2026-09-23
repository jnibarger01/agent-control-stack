/**
 * Audit timeline client behaviour: bounded live history, "load older" paging
 * over `GET /dashboard/events?beforeSequence=`, and a pause toggle that
 * buffers live events while the operator reads.
 */

/** Live events kept in the timeline before the oldest are trimmed. */
export const LIVE_TIMELINE_CAP = 200;
/** Page size for "load older". */
export const OLDER_EVENTS_PAGE = 50;

/** Relies on the dashboard client's `redactedAttributesJsonClient`, `fetchJson`, and `announce`. */
export function auditTimelineClientSource(): string {
  return `
let timelinePaused = false;
let timelineBuffer = [];
let timelineCap = ${LIVE_TIMELINE_CAP};
let timelineLoadingOlder = false;

function timelineList() {
  const root = document.getElementById('events-timeline');
  if (!root) return null;
  let list = root.querySelector('.timeline');
  if (!list) {
    root.querySelector('.empty')?.remove();
    list = document.createElement('ol');
    list.className = 'timeline';
    root.appendChild(list);
  }
  return list;
}

function timelineItemElement(data) {
  const item = document.createElement('li');
  if (data && data.sequence !== undefined) item.dataset.sequence = String(data.sequence);
  const time = document.createElement('time');
  const name = document.createElement('strong');
  const attrs = document.createElement('small');
  const nanos = Number(data && data.timeUnixNano);
  time.textContent = Number.isFinite(nanos) ? new Date(Math.floor(nanos / 1000000)).toLocaleString() : '';
  name.textContent = (data && data.name) || 'event';
  attrs.textContent = redactedAttributesJsonClient((data && data.attributes) || {});
  item.append(time, name, attrs);
  return item;
}

function renderTimelineControls() {
  const pause = document.getElementById('events-pause');
  if (pause) {
    pause.setAttribute('aria-pressed', timelinePaused ? 'true' : 'false');
    pause.textContent = timelinePaused
      ? 'Resume' + (timelineBuffer.length ? ' (' + timelineBuffer.length + ' new)' : '')
      : 'Pause';
  }
}

function insertLiveTimelineEvent(data) {
  if (timelinePaused) {
    timelineBuffer.push(data);
    renderTimelineControls();
    return;
  }
  const list = timelineList();
  if (!list) return;
  list.prepend(timelineItemElement(data));
  while (list.children.length > timelineCap) list.lastElementChild?.remove();
}

function setTimelinePaused(paused) {
  timelinePaused = paused;
  if (!paused && timelineBuffer.length) {
    const buffered = timelineBuffer;
    timelineBuffer = [];
    buffered.forEach(insertLiveTimelineEvent);
  }
  renderTimelineControls();
}

function oldestTimelineSequence() {
  const list = timelineList();
  const items = list ? Array.from(list.querySelectorAll('li[data-sequence]')) : [];
  let oldest = Infinity;
  items.forEach(function (item) {
    const value = Number(item.dataset.sequence);
    if (Number.isFinite(value) && value < oldest) oldest = value;
  });
  return Number.isFinite(oldest) ? oldest : null;
}

async function loadOlderTimelineEvents() {
  if (timelineLoadingOlder) return;
  const button = document.getElementById('events-load-older');
  const before = oldestTimelineSequence();
  if (before === null || before <= 1) {
    if (button) { button.disabled = true; button.textContent = 'No older events'; }
    return;
  }
  timelineLoadingOlder = true;
  if (button) button.disabled = true;
  try {
    const body = await fetchJson('/dashboard/events?beforeSequence=' + before + '&limit=${OLDER_EVENTS_PAGE}');
    const events = Array.isArray(body && body.events) ? body.events : [];
    const list = timelineList();
    // Server returns ascending; the timeline is newest-first.
    events.slice().reverse().forEach(function (event) { list.appendChild(timelineItemElement(event)); });
    timelineCap += events.length;
    announce(events.length ? 'Loaded ' + events.length + ' older events' : 'No older events');
    if (button) {
      const exhausted = events.length < ${OLDER_EVENTS_PAGE};
      button.disabled = exhausted;
      button.textContent = exhausted ? 'No older events' : 'Load older';
    }
  } catch (error) {
    announce('Could not load older events');
    if (button) button.disabled = false;
  } finally {
    timelineLoadingOlder = false;
  }
}

document.getElementById('events-pause')?.addEventListener('click', function () { setTimelinePaused(!timelinePaused); });
document.getElementById('events-load-older')?.addEventListener('click', function () { void loadOlderTimelineEvents(); });
`;
}
