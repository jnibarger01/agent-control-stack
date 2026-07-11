import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createTrace, verifyChain, detectReplayDivergence, redactSecrets, GENESIS_HASH,
} from '../src/trace-events.js';

const fixedClock = () => '2026-07-05T12:00:00.000Z';

function sampleRun(run_id = 'run-abc-000001') {
  const t = createTrace(run_id, { clock: fixedClock });
  t.append('task_received', { task_id: 'task-1' });
  t.append('task_validated', { ok: true });
  t.append('risk_classified', { effective_risk: 'write' });
  t.append('route_selected', { target: 'codex-swarm' });
  t.append('approval_requested', { risk: 'write' });
  t.append('approval_decision', { decision: 'approved', by: 'human' });
  t.append('run_completed', { status: 'ok' });
  return t;
}

test('chain verifies end-to-end and starts at genesis', () => {
  const t = sampleRun();
  assert.equal(t.events[0].prev_hash, GENESIS_HASH);
  const v = verifyChain(t.events);
  assert.equal(v.ok, true, v.reason ?? '');
});

test('payload tamper is detected at exact index', () => {
  const t = sampleRun();
  const tampered = t.events.map((e, i) =>
    i === 3 ? { ...e, payload: { target: 'dealpilot' } } : e);
  const v = verifyChain(tampered);
  assert.equal(v.ok, false);
  assert.equal(v.index, 3);
  assert.match(v.reason, /tampered/);
});

test('event deletion breaks the chain', () => {
  const t = sampleRun();
  const cut = t.events.filter((_, i) => i !== 2);
  const v = verifyChain(cut);
  assert.equal(v.ok, false);
  assert.equal(v.index, 2);
});

test('cross-run replay resistance: identical bodies under different run_id do not chain-verify as the original', () => {
  const a = sampleRun('run-aaa-000001');
  const b = sampleRun('run-bbb-000001');
  // splice one event from run B into run A's position -> chain must break
  const spliced = a.events.map((e, i) => (i === 4 ? b.events[4] : e));
  const v = verifyChain(spliced);
  assert.equal(v.ok, false);
});

test('unknown event type throws (schema enforcement at write time)', () => {
  const t = createTrace('run-xyz-000001');
  assert.throws(() => t.append('vibes_detected', {}), /unknown event type/);
});

test('run_failed normalizes bogus failure codes to unknown_failure', () => {
  const t = createTrace('run-fff-000001', { clock: fixedClock });
  const e = t.append('run_failed', { failure_code: 'gremlins' });
  assert.equal(e.payload.failure_code, 'unknown_failure');
});

test('secrets are redacted by category, values never stored', () => {
  const t = createTrace('run-sec-000001', { clock: fixedClock });
  const e = t.append('tool_call_finished', {
    stdout: 'export OPENAI_KEY=sk-abcdefghijklmnopqrstuvwx and token=ghp_ABCDEFGHIJKLMNOPQRST12',
  });
  assert.equal(e.redacted, true);
  assert.ok(!e.payload.stdout.includes('sk-abcdefghijklmnopqrstuvwx'));
  assert.ok(e.payload.stdout.includes('[REDACTED:api_key]'));
  assert.ok(e.payload.stdout.includes('[REDACTED:github_token]'));
});

test('redactSecrets catches credential assignments and bearer tokens', () => {
  const r1 = redactSecrets('password: hunter2hunter2');
  assert.equal(r1.redacted, true);
  const r2 = redactSecrets('Authorization: Bearer abcdef1234567890abcdef');
  assert.equal(r2.redacted, true);
});

test('sealed trace refuses further writes', () => {
  const t = sampleRun();
  t.seal();
  assert.equal(t.sealed, true);
  assert.throws(() => t.append('run_completed', {}), /sealed/);
  assert.equal(verifyChain(t.events).ok, true);
});

test('replay divergence: identical replays do not diverge (hashes/ts excluded)', () => {
  const a = sampleRun('run-one-000001');
  const b = createTrace('run-two-000001', { clock: () => '2026-07-06T09:00:00.000Z' });
  for (const e of a.events) b.append(e.type, e.payload);
  const d = detectReplayDivergence(a.events, b.events);
  assert.equal(d.diverged, false);
});

test('replay divergence: payload drift is caught at first divergent index', () => {
  const a = sampleRun('run-one-000002');
  const b = createTrace('run-two-000002', { clock: fixedClock });
  a.events.forEach((e, i) => b.append(e.type, i === 3 ? { target: 'dealpilot' } : e.payload));
  const d = detectReplayDivergence(a.events, b.events);
  assert.equal(d.diverged, true);
  assert.equal(d.index, 3);
});

test('replay divergence: truncated replay is caught', () => {
  const a = sampleRun('run-one-000003');
  const b = createTrace('run-two-000003', { clock: fixedClock });
  a.events.slice(0, 5).forEach((e) => b.append(e.type, e.payload));
  const d = detectReplayDivergence(a.events, b.events);
  assert.equal(d.diverged, true);
  assert.equal(d.index, 5);
});

test('sink receives every event (JSONL persistence hook)', () => {
  const lines = [];
  const t = createTrace('run-snk-000001', { sink: (e) => lines.push(JSON.stringify(e)), clock: fixedClock });
  t.append('task_received', {});
  t.append('run_completed', {});
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[1]).seq, 1);
});
