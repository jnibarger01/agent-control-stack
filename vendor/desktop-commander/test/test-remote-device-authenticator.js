import assert from 'node:assert/strict';
import {
  DeviceAuthenticator,
  buildAddDeviceUrl,
  buildVerifyDeviceUrl,
} from '../dist/remote-device/device-authenticator.js';

process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1';

const baseUrl = 'https://example.test/';
assert.equal(
  buildAddDeviceUrl(baseUrl, 'session /?x'),
  'https://example.test/add-device?session_id=session+%2F%3Fx',
);
assert.equal(
  buildVerifyDeviceUrl(baseUrl, 'ab&cd'),
  'https://example.test/verify-device?verify_device=true&user_code=ab%26cd',
);
assert.throws(() => buildAddDeviceUrl('javascript:alert(1)', 'session'), /http\(s\) origin/);

const calls = [];
const opened = [];
const states = [];
const responses = [
  new Response(JSON.stringify({ session_id: 'runtime-session', user_code: 'RUNTIME-CODE', expires_in: 30, interval: 1 }), { status: 200 }),
  new Response(JSON.stringify({ error: 'authorization_pending' }), { status: 400 }),
  new Response(JSON.stringify({ access_token: 'access', refresh_token: 'refresh', device_id: 'device' }), { status: 200 }),
];

const authenticator = new DeviceAuthenticator(baseUrl, {
  fetchImpl: async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return responses.shift();
  },
  openBrowser: async (url) => { opened.push(url); },
  sleep: async () => {},
  onStateChange: (state) => states.push(state),
});

const session = await authenticator.authenticate('device-id');
assert.deepEqual(session, { access_token: 'access', refresh_token: 'refresh', device_id: 'device' });
assert.deepEqual(opened, ['https://example.test/add-device?session_id=runtime-session']);
assert.equal(calls[0].url, 'https://example.test/device/start');
assert.equal(calls[1].url, 'https://example.test/device/poll');
assert.equal(calls[1].body.session_id, 'runtime-session');
assert.equal(calls[1].body.device_code, undefined);
assert.deepEqual(states, [
  'PAIRING_SESSION_CREATED',
  'ADD_DEVICE_PAGE_OPENED',
  'AWAITING_DEVICE_VERIFICATION',
  'DEVICE_VERIFIED',
]);

const browserFailureStates = [];
let browserFailurePoll = false;
const browserFailure = new DeviceAuthenticator(baseUrl, {
  fetchImpl: async (url) => {
    if (url.endsWith('/device/start')) {
      return new Response(JSON.stringify({ session_id: 'kept-session', user_code: 'KEPT-CODE', expires_in: 1, interval: 1 }), { status: 200 });
    }
    browserFailurePoll = true;
    return new Response(JSON.stringify({ error: 'authorization_pending' }), { status: 400 });
  },
  openBrowser: async () => { throw new Error('browser unavailable'); },
  sleep: async () => {},
  onStateChange: (state) => browserFailureStates.push(state),
});
await assert.rejects(() => browserFailure.authenticate(), /Authorization timeout/);
assert.equal(browserFailurePoll, true);
assert.deepEqual(browserFailureStates.slice(0, 3), [
  'PAIRING_SESSION_CREATED',
  'BROWSER_LAUNCH_FAILED',
  'AWAITING_DEVICE_VERIFICATION',
]);

const legacyCalls = [];
const legacyOpened = [];
const legacyResponses = [
  new Response(JSON.stringify({
    device_code: 'legacy-device-code',
    user_code: 'LEGACY-CODE',
    verification_uri: 'https://example.test/device/verify',
    verification_uri_complete: 'https://example.test/device/verify?user_code=LEGACY-CODE',
    expires_in: 30,
    interval: 1,
  }), { status: 200 }),
  new Response(JSON.stringify({ access_token: 'legacy-access', refresh_token: 'legacy-refresh' }), { status: 200 }),
];
const legacy = new DeviceAuthenticator(baseUrl, {
  fetchImpl: async (url, init) => {
    legacyCalls.push({ url, body: JSON.parse(init.body) });
    return legacyResponses.shift();
  },
  openBrowser: async (url) => { legacyOpened.push(url); },
  sleep: async () => {},
});
assert.deepEqual(await legacy.authenticate(), {
  device_id: undefined,
  access_token: 'legacy-access',
  refresh_token: 'legacy-refresh',
});
assert.deepEqual(legacyOpened, ['https://example.test/device/verify?user_code=LEGACY-CODE']);
assert.equal(legacyCalls[1].body.device_code, 'legacy-device-code');
assert.equal(legacyCalls[1].body.session_id, undefined);

console.log('remote device canonical pairing flow tests passed');
