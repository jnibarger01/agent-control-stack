#!/usr/bin/env node
import { ControlPlaneService, InMemoryControlPlaneStore } from '../dist/service.js';
import { readFile } from 'node:fs/promises';

let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log(`PASS  ${name}`); }
  catch (error) { failures++; console.error(`FAIL  ${name}\n  ${error.message}`); }
}
function assert(condition, message) { if (!condition) throw new Error(message); }
function makeHarness() {
  let now = new Date('2026-09-08T00:00:00.000Z');
  const store = new InMemoryControlPlaneStore();
  const service = new ControlPlaneService(store, { now: () => now, dispatchTimeoutMs: 50 });
  return { store, service, setNow: (value) => { now = new Date(value); } };
}
async function activate(h, userId, deviceId, sessionId = 'session-a', options = {}) {
  await h.service.bindDeviceSession(userId, deviceId, sessionId);
  await h.service.setPresence(userId, deviceId, {
    present: true,
    transport: 'broadcast_v1',
    localMcpReady: options.localMcpReady ?? true,
    connectionGeneration: options.connectionGeneration ?? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  });
}

await test('unreadable Presence fails closed to absent instead of throwing', async () => {
  const h = makeHarness();
  const device = await h.service.registerDevice('user-a', { device_name: 'A', capabilities: { transport_broadcast_v1: true } });
  await activate(h, 'user-a', device.id);
  h.store.readPresence = async () => { throw new Error('Supabase Presence sync timed out'); };
  const view = await h.service.getDevice('user-a', device.id);
  assert(view.present === false && view.effectiveOnline === false && view.reason === 'presence_absent', 'presence failure did not fail closed');
  let refused = false;
  try { await h.service.dispatch('user-a', device.id, { tool_name: 't', arguments: {}, idempotency_key: 'k' }); } catch (error) { refused = error.code === 'device_unavailable'; }
  assert(refused, 'dispatch not refused when Presence is unreadable');
});

await test('legacy persisted online status never makes an absent device effectively online', async () => {
  const h = makeHarness();
  const device = await h.service.registerDevice('user-a', { device_name: 'A', capabilities: {} });
  await h.store.setDiagnosticStatus('user-a', device.id, 'online');
  await h.service.bindDeviceSession('user-a', device.id, 'session-a');
  const state = await h.service.getDevice('user-a', device.id);
  assert(state.effectiveOnline === false, 'persisted status must never be an online authority');
  assert(state.present === false, 'absent Presence must remain absent');
});

await test('live Presence overrides stale persisted offline metadata', async () => {
  const h = makeHarness();
  const device = await h.service.registerDevice('user-a', { device_name: 'A', capabilities: { transport_broadcast_v1: true } });
  await h.store.setDiagnosticStatus('user-a', device.id, 'offline');
  await activate(h, 'user-a', device.id);
  const state = await h.service.getDevice('user-a', device.id);
  assert(state.registered && state.authenticated && state.present, 'registered/session/presence dimensions must be explicit');
  assert(state.effectiveOnline === true, 'Presence + authorization + session + transport must be online despite stale status');
  assert(state.executionReady === true, 'healthy local MCP should be execution ready');
});

await test('Presence without an active device session is not authenticated or dispatchable', async () => {
  const h = makeHarness();
  const device = await h.service.registerDevice('user-a', { device_name: 'A', capabilities: { transport_broadcast_v1: true } });
  await h.service.setPresence('user-a', device.id, { present: true, transport: 'broadcast_v1', localMcpReady: true, connectionGeneration: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
  const state = await h.service.getDevice('user-a', device.id);
  assert(state.present === true && state.authenticated === false, 'Presence must not imply authentication');
  assert(state.effectiveOnline === false && state.reason === 'device_session_missing', 'missing bound session must fail closed');
});

await test('local MCP readiness is distinct from transport Presence and gates execution', async () => {
  const h = makeHarness();
  const device = await h.service.registerDevice('user-a', { device_name: 'A', capabilities: { transport_broadcast_v1: true } });
  await activate(h, 'user-a', device.id, 'session-a', { localMcpReady: false });
  const state = await h.service.getDevice('user-a', device.id);
  assert(state.effectiveOnline === true && state.executionReady === false, 'transport may be online while local MCP is not ready');
  await h.service.dispatch('user-a', device.id, { tool_name: 'read_file', arguments: {}, idempotency_key: 'not-ready' }).then(
    () => { throw new Error('execution-unready device was dispatchable'); },
    (error) => assert(error.code === 'device_unavailable', `expected device_unavailable, got ${error.code}`),
  );
});

await test('revocation dominates Presence and active session state immediately', async () => {
  const h = makeHarness();
  const device = await h.service.registerDevice('user-a', { device_name: 'A', capabilities: { transport_broadcast_v1: true } });
  await activate(h, 'user-a', device.id);
  await h.service.revokeDevice('user-a', device.id);
  const state = await h.service.getDevice('user-a', device.id);
  assert(state.revoked === true && state.effectiveOnline === false && state.executionReady === false, 'revocation must immediately make device unusable');
});

await test('two device sessions cannot claim each other calls', async () => {
  const h = makeHarness();
  const a = await h.service.registerDevice('user-a', { device_name: 'A', capabilities: { transport_broadcast_v1: true } });
  const b = await h.service.registerDevice('user-a', { device_name: 'B', capabilities: { transport_broadcast_v1: true } });
  await activate(h, 'user-a', a.id, 'session-a');
  await activate(h, 'user-a', b.id, 'session-b');
  const call = await h.service.dispatch('user-a', a.id, { tool_name: 'read_file', arguments: {}, idempotency_key: 'isolation' });
  assert(await h.service.claim('user-a', a.id, call.id, 'session-b', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') === false, 'wrong device session must lose claim');
  assert(await h.service.claim('user-a', a.id, call.id, 'session-a', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') === true, 'bound device session must win claim');
});

await test('same-user second device cannot complete another device call', async () => {
  const h = makeHarness();
  const a = await h.service.registerDevice('user-a', { device_name: 'A', capabilities: { transport_broadcast_v1: true } });
  const b = await h.service.registerDevice('user-a', { device_name: 'B', capabilities: { transport_broadcast_v1: true } });
  await activate(h, 'user-a', a.id, 'session-a');
  await activate(h, 'user-a', b.id, 'session-b');
  const call = await h.service.dispatch('user-a', a.id, { tool_name: 'read_file', arguments: {}, idempotency_key: 'complete-isolation' });
  assert(await h.service.claim('user-a', a.id, call.id, 'session-a', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') === true, 'target device must claim before completion');
  await h.service.complete('user-a', b.id, call.id, 'session-b', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'completed', { leaked: true }, null).then(
    () => { throw new Error('same-user non-target device completed the call'); },
    (error) => assert(error.code === 'not_found', `expected not_found, got ${error.code}`),
  );
  const stored = await h.store.getCall('user-a', a.id, call.id);
  assert(stored?.status === 'executing' && stored.result === null, 'cross-device completion must not mutate target call');
});

await test('expired pending call is durably timed out and cannot be claimed', async () => {
  const h = makeHarness();
  const device = await h.service.registerDevice('user-a', { device_name: 'A', capabilities: { transport_broadcast_v1: true } });
  await activate(h, 'user-a', device.id, 'session-a');
  const call = await h.service.dispatch('user-a', device.id, { tool_name: 'read_file', arguments: {}, idempotency_key: 'timeout' });
  h.setNow('2026-09-08T00:00:00.070Z');
  const expired = await h.service.getCall('user-a', device.id, call.id);
  assert(expired.status === 'timed_out', `expected timed_out, got ${expired.status}`);
  assert(await h.service.claim('user-a', device.id, call.id, 'session-a', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') === false, 'durably timed-out call must not be claimable');
  const stored = await h.store.getCall('user-a', device.id, call.id);
  assert(stored?.status === 'timed_out', `durable row stayed ${stored?.status}`);
});

await test('late completion durably times out executing call and cannot overwrite it', async () => {
  const h = makeHarness();
  const device = await h.service.registerDevice('user-a', { device_name: 'A', capabilities: { transport_broadcast_v1: true } });
  await activate(h, 'user-a', device.id, 'session-a');
  const call = await h.service.dispatch('user-a', device.id, { tool_name: 'read_file', arguments: {}, idempotency_key: 'late-completion' });
  assert(await h.service.claim('user-a', device.id, call.id, 'session-a', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') === true, 'call must be executing before deadline race');
  h.setNow('2026-09-08T00:00:00.070Z');
  await h.service.complete('user-a', device.id, call.id, 'session-a', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'completed', { late: true }, null).then(
    () => { throw new Error('late completion was accepted'); },
    (error) => assert(error.code === 'not_found', `expected not_found, got ${error.code}`),
  );
  const stored = await h.store.getCall('user-a', device.id, call.id);
  assert(stored?.status === 'timed_out', `late completion overwrote durable status: ${stored?.status}`);
  assert(stored?.result === null && stored?.error_message === 'dispatch timed out', 'timed-out call must retain timeout terminal payload');
});

await test('dispatch freezes the active auth session and Presence generation into the durable call', async () => {
  const h = makeHarness();
  const device = await h.service.registerDevice('user-a', { device_name: 'A', capabilities: { transport_broadcast_v1: true } });
  await activate(h, 'user-a', device.id, 'session-a', { connectionGeneration: '77777777-7777-4777-8777-777777777777' });
  const call = await h.service.dispatch('user-a', device.id, { tool_name: 'read_file', arguments: {}, idempotency_key: 'fence' });
  assert(call.target_auth_session_id === 'session-a', `wrong target session ${call.target_auth_session_id}`);
  assert(call.target_connection_generation === '77777777-7777-4777-8777-777777777777', `wrong target generation ${call.target_connection_generation}`);
});

await test('a later Presence connection generation cannot execute a call targeted to an earlier generation', async () => {
  const h = makeHarness();
  const device = await h.service.registerDevice('user-a', { device_name: 'A', capabilities: { transport_broadcast_v1: true } });
  await activate(h, 'user-a', device.id, 'session-a', { connectionGeneration: '77777777-7777-4777-8777-777777777777' });
  const call = await h.service.dispatch('user-a', device.id, { tool_name: 'read_file', arguments: {}, idempotency_key: 'generation-fence' });
  assert(await h.service.claim('user-a', device.id, call.id, 'session-a', '88888888-8888-4888-8888-888888888888') === false, 'new generation must not inherit uncertain old work');
  assert(await h.service.claim('user-a', device.id, call.id, 'session-a', '77777777-7777-4777-8777-777777777777') === true, 'targeted generation should claim');
});

await test('duplicate delivery has exactly one session-bound claim winner', async () => {
  const h = makeHarness();
  const device = await h.service.registerDevice('user-a', { device_name: 'A', capabilities: { transport_broadcast_v1: true } });
  await activate(h, 'user-a', device.id, 'session-a');
  const [first, duplicate] = await Promise.all([
    h.service.dispatch('user-a', device.id, { tool_name: 'read_file', arguments: {}, idempotency_key: 'idem' }),
    h.service.dispatch('user-a', device.id, { tool_name: 'read_file', arguments: {}, idempotency_key: 'idem' }),
  ]);
  assert(first.id === duplicate.id, 'idempotent create must return one durable call');
  const [x, y] = await Promise.all([
    h.service.claim('user-a', device.id, first.id, 'session-a', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
    h.service.claim('user-a', device.id, first.id, 'session-a', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  ]);
  assert(Number(x) + Number(y) === 1, 'exactly one claim may win');
});


await test('migration binds device execution to Supabase session_id and never to status', async () => {
  const sql = await readFile(new URL('../supabase/migrations/20260924204925_control_plane_v1.sql', import.meta.url), 'utf8');
  assert(sql.includes('create table if not exists public.mcp_device_sessions'), 'device session binding table is required');
  assert(sql.includes("auth.jwt() ->> 'session_id'"), 'device authorization must bind to verified JWT session_id');
  assert(sql.includes('target_connection_generation'), 'calls must fence execution to the Presence connection generation observed at dispatch');
  assert(sql.includes('p_device_id uuid, p_connection_generation uuid'), 'claim and complete RPCs must accept an explicit target device binding');
  assert(sql.includes('c.id = p_call_id and c.user_id = v_user and c.device_id = p_device_id'), 'claim and complete SQL transitions must bind call ID, user, and target device atomically');
  assert(sql.includes('Returning NULL ensures the late worker cannot treat it as success'), 'late completion must durably time out and fail the completion request');
  assert(sql.includes("realtime.send("), 'durable call transitions must ring Broadcast doorbells from Postgres');
  assert(sql.includes("user:' ||") && sql.includes("':device:' ||"), 'doorbells must target per-device user-scoped topics');
  assert(!/where[^;]*status\s*=\s*'online'/is.test(sql), 'persisted status must never authorize call creation or execution');
});

await test('migration authorizes private Realtime Presence by owner and bound device session without custom dispatcher roles', async () => {
  const sql = await readFile(new URL('../supabase/migrations/20260924204925_control_plane_v1.sql', import.meta.url), 'utf8');
  assert(sql.includes('on realtime.messages'), 'Realtime authorization policies must be migration-managed');
  assert(sql.includes("realtime.messages.extension = 'presence'"), 'Presence publish policy must be explicit');
  assert(sql.includes('realtime.topic()'), 'Realtime authorization must bind the requested topic');
  assert(sql.includes('mcp_realtime_presence_publish'), 'named Presence publish policy is required');
  assert(!sql.includes('control_plane_dispatcher'), 'no second dispatcher database role/control plane is allowed');
  assert(!sql.includes('PRESENCE_AUTHORITY'), 'no external Presence authority may be required');
});

process.exitCode = failures === 0 ? 0 : 1;
