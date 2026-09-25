#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../src/control-plane/server.ts', import.meta.url), 'utf8');
let failures = 0;
function test(name, fn) { try { fn(); console.log(`PASS  ${name}`); } catch (e) { failures++; console.error(`FAIL  ${name}\n  ${e.message}`); } }
function assert(v, m) { if (!v) throw new Error(m); }

test('server has one Supabase boundary and no external Presence/dispatcher authority', () => {
  assert(source.includes('SUPABASE_SECRET_KEY'), 'server secret env boundary missing');
  assert(!source.includes('PRESENCE_AUTHORITY'), 'old Presence authority still wired');
  assert(!source.includes('CONTROL_PLANE_DISPATCHER'), 'old dispatcher still wired');
});
test('mcp-info advertises v1 compatibility without exposing server secret', () => {
  assert(source.includes('controlPlaneVersion: 1'), 'mcp-info must advertise control plane v1');
  assert(source.includes('deviceRegistrationEndpoint'), 'mcp-info must advertise registration endpoint');
  assert(!source.includes('supabaseSecretKey:'), 'server secret must never be serialized');
});
test('authenticated requests require live Supabase session_id and device registration checks OAuth client_id', () => {
  assert(source.includes('session_id'), 'session_id validation missing');
  assert(source.includes('client_id'), 'OAuth client_id validation missing');
  assert(source.includes('control_plane_auth_session_active_server'), 'live auth.sessions check missing');
  assert(source.includes("api/devices/register"), 'device registration route missing');
});
test('pairing never hands a user/device token to the device', () => {
  assert(!source.includes('access_token: result'), 'poll still returns a held access token');
  assert(!source.includes("'verify-device'"), 'unauthenticated verify-device route still present');
  assert(!source.includes("'device/verify'"), 'browser-token verify route still present');
  assert(source.includes('authorization_code'), 'poll must return the authorization code for device-side exchange');
});
test('/mcp is authenticated and advertises protected resource metadata', () => {
  assert(source.includes('resource_metadata='), 'WWW-Authenticate resource_metadata missing');
  assert(source.includes('.well-known/oauth-protected-resource'), 'protected resource metadata route missing');
  assert(!source.includes('mcp_not_implemented'), 'stub /mcp still present');
});
process.exitCode = failures ? 1 : 0;
