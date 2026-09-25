#!/usr/bin/env node
/**
 * Runs the consent page's real inline script in a VM with a fake DOM and a fake
 * supabase-js, and checks that what it renders comes from getAuthorizationDetails
 * for whichever OAuth client is asking.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { createControlPlaneServer } from '../dist/control-plane/server.js';
import { InMemoryPairingStore } from '../dist/control-plane/pairing-store.js';

const config = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'test-publishable-key',
  SUPABASE_SECRET_KEY: 'test-secret-key',
  DEVICE_OAUTH_CLIENT_ID: 'device-client',
  PAIRING_STATE_KEY: crypto.randomBytes(32).toString('base64'),
  PAIRING_CODE_KEY: crypto.randomBytes(32).toString('base64'),
  CONTROL_PLANE_URL: 'https://relay.example.test:8443',
};
const server = createControlPlaneServer(config, { pairingStore: new InMemoryPairingStore(), authenticate: async () => { throw new Error('unused'); } });
server.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log(`PASS  ${name}`); }
  catch (error) { failures++; console.error(`FAIL  ${name}\n  ${error.stack || error.message}`); }
}

function element(id) {
  const el = {
    id, textContent: '', hidden: id === 'signin' || id === 'consent', disabled: false, value: '', children: [], listeners: {},
    addEventListener(type, fn) { this.listeners[type] = fn; },
    appendChild(child) { this.children.push(child); return child; },
  };
  Object.defineProperty(el, 'textContent', {
    get() { return this._text ?? (this.children.length ? this.children.map((c) => c.textContent).join('|') : ''); },
    set(value) { this._text = value === '' ? undefined : value; if (value === '') this.children = []; },
  });
  return el;
}

async function renderConsent({ session = { access_token: 't' }, sessionError = null, initializeError = null, search = '?authorization_id=auth-123', hash = '', validOtp = null, details, detailsError = null } = {}) {
  const html = await (await fetch(`${base}/oauth/consent${search}`)).text();
  const scripts = [...html.matchAll(/<script nonce="[^"]+">([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.equal(scripts.length, 1, 'expected one inline script');
  const elements = new Map();
  const calls = { approve: [], deny: [], assigned: [], createClient: [] };
  const location = { search, hash, href: `https://relay.example.test:8443/oauth/consent${search}${hash}`, assign: (url) => calls.assigned.push(url) };
  const fakeClient = {
    auth: {
      initialize: async () => {
        calls.initialized = true;
        if (location.hash) location.hash = '';
        return { error: initializeError };
      },
      getSession: async () => ({ data: { session }, error: sessionError }),
      signOut: async () => ({}),
      signInWithOtp: async (params) => { calls.signInWithOtp = params; return { error: null }; },
      verifyOtp: async (params) => { calls.verifyOtp = params; return validOtp && params.email === validOtp.email && params.token === validOtp.token && params.type === 'email' ? { data: { session: { access_token: 'fresh' } }, error: null } : { data: null, error: { message: 'Token has expired or is invalid' } }; },
      oauth: {
        getAuthorizationDetails: async (id) => { calls.detailsFor = id; return { data: details, error: detailsError }; },
        approveAuthorization: async (id, opts) => { calls.approve.push({ id, opts }); return { data: { redirect_url: 'https://client.example/cb?code=x' }, error: null }; },
        denyAuthorization: async (id, opts) => { calls.deny.push({ id, opts }); return { data: { redirect_url: 'https://client.example/cb?error=access_denied' }, error: null }; },
      },
    },
  };
  const context = {
    URL, URLSearchParams, console,
    document: {
      getElementById: (id) => { if (!elements.has(id)) elements.set(id, element(id)); return elements.get(id); },
      createElement: (tag) => element(tag),
    },
    location,
    history: { replaceState: (...args) => { calls.replaceState = args; } },
  };
  context.window = { supabase: { createClient: (url, key, options) => { calls.createClient.push({ url, key, options }); return fakeClient; } } };
  vm.createContext(context);
  vm.runInContext(scripts[0], context);
  await context.window.__consentReady;
  return { html, el: (id) => context.document.getElementById(id), calls: JSON.parse(JSON.stringify(calls)), liveCalls: calls, location };
}

try {
  await test('renders the requesting client name, host, id, account and each scope from getAuthorizationDetails', async () => {
    const { el, calls } = await renderConsent({ details: {
      authorization_id: 'auth-123', scope: 'openid email profile',
      client: { id: 'claude-client-id', name: 'Claude', uri: 'https://claude.ai/about', logo_uri: '' },
      user: { id: 'u', email: 'jace@example.com' },
    } });
    assert.equal(calls.detailsFor, 'auth-123');
    assert.equal(el('consent').hidden, false);
    assert.equal(el('client-name').textContent, 'Claude');
    assert.equal(el('client-host').textContent, '(claude.ai)');
    assert.equal(el('client-id').textContent, 'claude-client-id');
    assert.equal(el('user-email').textContent, 'jace@example.com');
    assert.deepEqual(el('scopes').children.map((c) => c.textContent), ['openid', 'email', 'profile']);
  });

  await test('a different client (device pairing) renders its own details, not hard-coded text', async () => {
    const { el } = await renderConsent({ details: {
      authorization_id: 'auth-123', scope: '',
      client: { id: 'device-client', name: 'dc-relay-device', uri: '', logo_uri: '' },
      user: { id: 'u', email: 'jace@example.com' },
    } });
    assert.equal(el('client-name').textContent, 'dc-relay-device');
    assert.equal(el('client-host').textContent, '');
    assert.deepEqual(el('scopes').children.map((c) => c.textContent), ['(default)']);
  });

  await test('approve and deny act on the same authorization_id and follow the returned redirect', async () => {
    const details = { authorization_id: 'auth-123', scope: 'openid', client: { id: 'c', name: 'Claude', uri: '' }, user: { email: 'j@example.com' } };
    const approved = await renderConsent({ details });
    await approved.el('approve').listeners.click();
    await new Promise((resolve) => setImmediate(resolve));
    const approvedCalls = JSON.parse(JSON.stringify(approved.liveCalls));
    assert.deepEqual(approvedCalls.approve, [{ id: 'auth-123', opts: { skipBrowserRedirect: true } }]);
    assert.deepEqual(approvedCalls.assigned, ['https://client.example/cb?code=x']);
    const denied = await renderConsent({ details });
    await denied.el('deny').listeners.click();
    await new Promise((resolve) => setImmediate(resolve));
    const deniedCalls = JSON.parse(JSON.stringify(denied.liveCalls));
    assert.equal(deniedCalls.deny[0].id, 'auth-123');
    assert.deepEqual(deniedCalls.assigned, ['https://client.example/cb?error=access_denied']);
  });

  await test('already-consented authorization redirects without showing the prompt', async () => {
    const { el, calls } = await renderConsent({ details: { redirect_url: 'https://client.example/cb?code=y', client: { name: 'Claude' } } });
    assert.deepEqual(calls.assigned, ['https://client.example/cb?code=y']);
    assert.equal(el('consent').hidden, true);
  });

  await test('signed out shows email sign-in and does not fetch details', async () => {
    const { el, calls } = await renderConsent({ session: null, details: { client: { name: 'Claude' } } });
    assert.equal(el('signin').hidden, false);
    assert.equal(el('consent').hidden, true);
    assert.equal(calls.detailsFor, undefined);
  });

  await test('email magic-link sign-in uses implicit browser auth instead of a tab-bound PKCE verifier', async () => {
    const { calls } = await renderConsent({ session: null, details: { client: { name: 'Claude' } } });
    assert.equal(calls.createClient.length, 1);
    assert.equal(calls.createClient[0].options.auth.flowType, 'implicit');
    assert.equal(calls.createClient[0].options.auth.detectSessionInUrl, true);
  });

  await test('in-flight PKCE callbacks stay compatible but replacement email sign-in resets to implicit', async () => {
    const { el, calls, liveCalls } = await renderConsent({
      session: { access_token: 'fresh' },
      search: '?authorization_id=auth-123&code=pkce-code',
      details: { authorization_id: 'auth-123', scope: 'openid', client: { id: 'c', name: 'Claude', uri: '' }, user: { email: 'jace@example.com' } },
    });
    assert.equal(calls.createClient[0].options.auth.flowType, 'pkce');
    assert.deepEqual(calls.replaceState, [null, '', 'https://relay.example.test:8443/oauth/consent?authorization_id=auth-123']);

    el('email').value = 'jace@example.com';
    await el('email-form').listeners.submit({ preventDefault() {} });
    assert.equal(liveCalls.createClient.length, 2);
    assert.equal(liveCalls.createClient[1].options.auth.flowType, 'implicit');
    assert.equal(liveCalls.signInWithOtp.options.emailRedirectTo, 'https://relay.example.test:8443/oauth/consent?authorization_id=auth-123');
  });

  await test('email sign-in keeps the OAuth authorization request in the magic-link return URL', async () => {
    const { el, liveCalls } = await renderConsent({ session: null, details: { client: { name: 'Claude' } } });
    el('email').value = 'jace@example.com';
    await el('email-form').listeners.submit({ preventDefault() {} });
    assert.equal(liveCalls.signInWithOtp.email, 'jace@example.com');
    assert.equal(liveCalls.signInWithOtp.options.shouldCreateUser, false);
    assert.equal(liveCalls.signInWithOtp.options.emailRedirectTo, 'https://relay.example.test:8443/oauth/consent?authorization_id=auth-123');
  });

  await test('magic-link callback credentials are scrubbed after auth-js clears the fragment', async () => {
    const ok = await renderConsent({
      session: { access_token: 'fresh' },
      hash: '#access_token=fresh&refresh_token=refresh&type=magiclink',
      details: {
        authorization_id: 'auth-123', scope: 'openid',
        client: { id: 'c', name: 'Claude', uri: '' },
        user: { email: 'jace@example.com' },
      },
    });
    assert.equal(ok.calls.initialized, true);
    assert.equal(ok.location.hash, '');
    assert.deepEqual(ok.calls.replaceState, [null, '', 'https://relay.example.test:8443/oauth/consent?authorization_id=auth-123']);
  });

  await test('initialize callback errors stay visible when getSession has no error', async () => {
    const failed = await renderConsent({
      session: null,
      initializeError: { message: 'Magic-link session could not be established' },
      hash: '#error=access_denied&error_description=Magic-link%20session%20could%20not%20be%20established',
      details: { client: { name: 'Claude' } },
    });
    assert.equal(failed.el('signin').hidden, false);
    assert.equal(failed.el('status').textContent, 'Magic-link session could not be established');
    assert.equal(failed.calls.detailsFor, undefined);
    assert.deepEqual(failed.calls.replaceState, [null, '', 'https://relay.example.test:8443/oauth/consent?authorization_id=auth-123']);
  });

  await test('session-detection errors remain visible', async () => {
    const failed = await renderConsent({
      session: null,
      sessionError: { message: 'Magic-link session could not be established' },
      details: { client: { name: 'Claude' } },
    });
    assert.equal(failed.el('signin').hidden, false);
    assert.equal(failed.el('status').textContent, 'Magic-link session could not be established');
    assert.equal(failed.calls.detailsFor, undefined);
  });

  await test('query-form callback errors are scrubbed before a replacement sign-in', async () => {
    const failed = await renderConsent({
      session: null,
      search: '?authorization_id=auth-123&error=access_denied&error_code=otp_expired&error_description=Expired%20sign-in%20link&error_uri=https%3A%2F%2Fexample.invalid%2Fhelp',
      details: { client: { name: 'Claude' } },
    });
    assert.equal(failed.el('signin').hidden, false);
    assert.equal(failed.el('status').textContent, 'Expired sign-in link');
    assert.deepEqual(failed.calls.replaceState, [null, '', 'https://relay.example.test:8443/oauth/consent?authorization_id=auth-123']);

    failed.el('email').value = 'jace@example.com';
    await failed.el('email-form').listeners.submit({ preventDefault() {} });
    assert.equal(failed.liveCalls.signInWithOtp.options.emailRedirectTo, 'https://relay.example.test:8443/oauth/consent?authorization_id=auth-123');
  });

  await test('"Have a code?" is available without sending an email; valid code → session → client details shown', async () => {
    const details = { authorization_id: 'auth-123', scope: 'openid email', client: { id: 'claude-client-id', name: 'Claude', uri: 'https://claude.ai' }, user: { email: 'jace@example.com' } };
    const { el, calls, liveCalls } = await renderConsent({ session: null, details, validOtp: { email: 'jace@example.com', token: '123456' } });
    assert.equal(el('signin').hidden, false);
    assert.equal(el('otp-form').hidden, false, 'code entry hidden until an email is sent');
    assert.equal(calls.detailsFor, undefined, 'details fetched before sign-in');
    el('email').value = ' jace@example.com ';
    el('otp').value = ' 123456 ';
    await el('otp-form').listeners.submit({ preventDefault() {} });
    const after = JSON.parse(JSON.stringify(liveCalls));
    assert.deepEqual(after.verifyOtp, { email: 'jace@example.com', token: '123456', type: 'email' });
    assert.equal(after.detailsFor, 'auth-123');
    assert.equal(el('consent').hidden, false);
    assert.equal(el('client-name').textContent, 'Claude');
    assert.deepEqual(el('scopes').children.map((c) => c.textContent), ['openid', 'email']);
  });

  await test('wrong code → error shown, no session, no authorization details fetched', async () => {
    const { el, liveCalls } = await renderConsent({ session: null, details: { client: { name: 'Claude' } }, validOtp: { email: 'jace@example.com', token: '123456' } });
    el('email').value = 'jace@example.com';
    el('otp').value = '000000';
    await el('otp-form').listeners.submit({ preventDefault() {} });
    assert.equal(liveCalls.detailsFor, undefined);
    assert.equal(el('consent').hidden, true);
    assert.equal(el('status').textContent, 'Token has expired or is invalid');
    el('email').value = '';
    el('otp').value = '123456';
    await el('otp-form').listeners.submit({ preventDefault() {} });
    assert.equal(el('status').textContent, 'Enter your email above and the code.');
  });

  await test('invalid request and missing authorization_id show a generic restart message', async () => {
    const invalid = await renderConsent({ details: null, detailsError: { message: 'authorization not found' } });
    assert.match(invalid.el('status').textContent, /authorization not found\. Start again from the application that sent you here\./);
    const missing = await renderConsent({ details: {}, search: '' });
    assert.match(missing.el('status').textContent, /Missing authorization_id/);
  });

  await test('page markup makes no device-pairing assumption', async () => {
    const html = await (await fetch(`${base}/oauth/consent?authorization_id=x`)).text();
    // <head> carries width=device-width in the viewport meta; only the rendered body matters.
    const visible = html.slice(html.indexOf('<body>')).replace(/<script[\s\S]*?<\/script>/g, '');
    assert.doesNotMatch(visible, /device|pairing/i);
    const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1];
    assert.doesNotMatch(script, /device|pairing/i);
    assert.match(visible, /Enter an 8-digit code only if one was issued separately/);
    assert.match(visible, /standard Supabase sign-in email contains a link, not a code/);
    assert.doesNotMatch(visible, /6-digit/);
  });
} finally {
  await new Promise((resolve) => server.close(resolve));
}
process.exitCode = failures ? 1 : 0;
