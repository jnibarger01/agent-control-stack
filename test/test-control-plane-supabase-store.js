#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { parseDevicePresenceState, deviceTopic } from '../dist/control-plane/supabase-store.js';

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`PASS  ${name}`); }
  catch (error) { failures++; console.error(`FAIL  ${name}\n  ${error.message}`); }
}
function assert(value, message) { if (!value) throw new Error(message); }

const DEVICE = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';

test('device topic is user-scoped and device-scoped', () => {
  assert(deviceTopic(USER, DEVICE) === `user:${USER}:device:${DEVICE}`, 'wrong private topic');
});

test('Presence parser requires exact device identity and exposes readiness separately', () => {
  const state = {
    [DEVICE]: [{ device_id: DEVICE, device_name: 'jacen', transport: 'broadcast_v1', local_mcp_ready: true, connection_generation: '77777777-7777-4777-8777-777777777777' }],
  };
  const parsed = parseDevicePresenceState(DEVICE, state);
  assert(parsed.present === true, 'expected present');
  assert(parsed.transport === 'broadcast_v1', 'wrong transport');
  assert(parsed.localMcpReady === true, 'local MCP readiness lost');
  assert(parsed.connectionGeneration === '77777777-7777-4777-8777-777777777777', 'connection generation lost');
});

test('Presence parser fails closed on mismatched payload identity', () => {
  const parsed = parseDevicePresenceState(DEVICE, { [DEVICE]: [{ device_id: '33333333-3333-4333-8333-333333333333', transport: 'broadcast_v1', local_mcp_ready: true, connection_generation: 1 }] });
  assert(parsed.present === false, 'mismatched payload impersonated device');
});

test('multiple live Presence payloads for one device fail closed as split-brain', () => {
  const parsed = parseDevicePresenceState(DEVICE, { [DEVICE]: [
    { device_id: DEVICE, transport: 'broadcast_v1', local_mcp_ready: true, connection_generation: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
    { device_id: DEVICE, transport: 'broadcast_v1', local_mcp_ready: true, connection_generation: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
  ] });
  assert(parsed.present === true, 'transport is present');
  assert(parsed.connectionGeneration === null, 'ambiguous live processes must not yield a dispatch generation');
});

const source = await readFile(new URL('../src/control-plane/supabase-store.ts', import.meta.url), 'utf8');
test('production adapter uses Supabase Realtime directly and no external Presence authority', () => {
  assert(source.includes('.presenceState()'), 'adapter must inspect live Supabase Presence state');
  assert(source.includes('private: true'), 'Presence channel must be private');
  assert(!source.includes('PRESENCE_AUTHORITY'), 'external Presence authority must not exist');
  assert(!source.includes('control_plane_dispatcher'), 'custom dispatcher role must not exist');
});

test('server secret is separate from publishable client configuration', () => {
  assert(source.includes('serverSecretKey'), 'server-only Supabase secret key boundary missing');
  assert(source.includes('publishableKey'), 'publishable key boundary missing');
});

process.exitCode = failures ? 1 : 0;
