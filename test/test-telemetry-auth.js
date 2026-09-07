import assert from 'assert';
import crypto from 'crypto';

import {
  computeTelemetrySignature,
  buildTelemetryAuthHeaders,
  sanitizeTelemetryProperties,
} from '../dist/utils/capture.js';

const SIGNING_KEY_ENV = 'DESKTOP_COMMANDER_TELEMETRY_SIGNING_KEY';
const SIGNING_KEY_ID_ENV = 'DESKTOP_COMMANDER_TELEMETRY_SIGNING_KEY_ID';

function withEnv(overrides, fn) {
  const previous = {};
  for (const key of Object.keys(overrides)) {
    previous[key] = process.env[key];
    if (overrides[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = overrides[key];
    }
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(previous)) {
      if (previous[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous[key];
      }
    }
  }
}

function testUnsignedByDefault() {
  console.log('\n--- Test: telemetry requests are unsigned when no key is configured ---');

  withEnv({ [SIGNING_KEY_ENV]: undefined, [SIGNING_KEY_ID_ENV]: undefined }, () => {
    const headers = buildTelemetryAuthHeaders(JSON.stringify({ event: 'test' }));
    assert.deepStrictEqual(headers, {}, 'no signing key configured must mean no auth headers, and no behavior change');
  });

  console.log('ok: unsigned by default (no regression)');
}

function testSignedWhenKeyConfigured() {
  console.log('\n--- Test: telemetry requests are HMAC-signed once a key is configured ---');

  withEnv({ [SIGNING_KEY_ENV]: 'test-secret', [SIGNING_KEY_ID_ENV]: 'key-42' }, () => {
    const payload = JSON.stringify({ event: 'server_read_file', client_id: 'abc' });
    const headers = buildTelemetryAuthHeaders(payload);

    assert.ok(headers['X-DC-Telemetry-Timestamp'], 'timestamp header must be present');
    assert.strictEqual(headers['X-DC-Telemetry-Key-Id'], 'key-42', 'key id header must reflect configured key id');
    assert.ok(headers['X-DC-Telemetry-Signature']?.startsWith('sha256='), 'signature header must be sha256-prefixed');

    // Independently re-derive the signature the way a verifying server would,
    // to prove the header is a real function of (secret, timestamp, payload)
    // and not just an opaque constant.
    const timestamp = headers['X-DC-Telemetry-Timestamp'];
    const expected = crypto.createHmac('sha256', 'test-secret').update(`${timestamp}.${payload}`).digest('hex');
    assert.strictEqual(headers['X-DC-Telemetry-Signature'], `sha256=${expected}`, 'signature must match independent HMAC computation');
  });

  console.log('ok: signed when key configured');
}

function testSignatureChangesWithPayloadOrSecret() {
  console.log('\n--- Test: signature is bound to both payload and secret ---');

  const timestamp = '1700000000000';
  const sigA = computeTelemetrySignature('secret-a', timestamp, 'payload-1');
  const sigB = computeTelemetrySignature('secret-b', timestamp, 'payload-1');
  const sigC = computeTelemetrySignature('secret-a', timestamp, 'payload-2');

  assert.notStrictEqual(sigA, sigB, 'different secrets must produce different signatures for the same payload');
  assert.notStrictEqual(sigA, sigC, 'different payloads must produce different signatures for the same secret');
  assert.strictEqual(
    computeTelemetrySignature('secret-a', timestamp, 'payload-1'),
    sigA,
    'signing must be deterministic for identical (secret, timestamp, payload)'
  );

  console.log('ok: signature bound to payload and secret');
}

function testDefaultKeyIdWhenUnset() {
  console.log('\n--- Test: key id defaults when only the signing key is set ---');

  withEnv({ [SIGNING_KEY_ENV]: 'test-secret', [SIGNING_KEY_ID_ENV]: undefined }, () => {
    const headers = buildTelemetryAuthHeaders('{}');
    assert.strictEqual(headers['X-DC-Telemetry-Key-Id'], 'default');
  });

  console.log('ok: default key id applied');
}

function testSensitivePropertiesAreStripped() {
  console.log('\n--- Test: sensitive property keys are stripped from telemetry payloads ---');

  const properties = {
    event: 'server_start_process',
    fileExtension: '.ts', // must survive — explicitly allow-listed
    filePath: '/home/alice/secret-project/notes.txt',
    sourcePath: '/home/alice/foo',
    apiKey: 'sk-does-not-matter',
    api_key: 'sk-does-not-matter',
    authToken: 'abc123',
    authorizationHeader: 'Bearer abc123',
    userPassword: 'hunter2',
    sessionCookie: 'a=b',
    someSecretValue: 'xyz',
    safeCount: 42,
  };

  sanitizeTelemetryProperties(properties);

  assert.strictEqual(properties.event, 'server_start_process');
  assert.strictEqual(properties.fileExtension, '.ts', 'fileExtension must be explicitly kept');
  assert.strictEqual(properties.safeCount, 42);

  for (const key of [
    'filePath', 'sourcePath', 'apiKey', 'api_key', 'authToken',
    'authorizationHeader', 'userPassword', 'sessionCookie', 'someSecretValue',
  ]) {
    assert.ok(!(key in properties), `${key} must be stripped from telemetry properties`);
  }

  console.log('ok: sensitive properties stripped');
}

export default async function runTests() {
  try {
    testUnsignedByDefault();
    testSignedWhenKeyConfigured();
    testSignatureChangesWithPayloadOrSecret();
    testDefaultKeyIdWhenUnset();
    testSensitivePropertiesAreStripped();

    console.log('\nTelemetry auth/redaction tests passed.');
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Telemetry auth test failed:', message);
    if (error instanceof Error && error.stack) {
      console.error(error.stack);
    }
    return false;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runTests()
    .then((success) => {
      process.exit(success ? 0 : 1);
    })
    .catch((error) => {
      console.error('Unhandled error:', error);
      process.exit(1);
    });
}
