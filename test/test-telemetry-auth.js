import assert from 'assert';

import {
  telemetryBearerToken,
  sanitizeTelemetryProperties,
} from '../dist/utils/capture.js';

const TOKEN_ENV = 'DESKTOP_COMMANDER_TELEMETRY_BEARER_TOKEN';

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

function testNoTokenByDefault() {
  console.log('\n--- Test: no bearer token configured means telemetry cannot authenticate ---');

  withEnv({ [TOKEN_ENV]: undefined }, () => {
    assert.strictEqual(telemetryBearerToken(), undefined, 'no token configured must mean no authenticated transport');
  });

  console.log('ok: unauthenticated by default when no token is configured (send is gated on this)');
}

function testTokenReturnedWhenConfigured() {
  console.log('\n--- Test: a configured token is returned trimmed ---');

  withEnv({ [TOKEN_ENV]: '  test-bearer-token-123  ' }, () => {
    assert.strictEqual(telemetryBearerToken(), 'test-bearer-token-123', 'token must be trimmed');
  });

  console.log('ok: token trimmed and returned');
}

function testOversizedTokenRejected() {
  console.log('\n--- Test: an oversized token is rejected rather than sent ---');

  withEnv({ [TOKEN_ENV]: 'x'.repeat(4097) }, () => {
    assert.strictEqual(telemetryBearerToken(), undefined, 'a token over the 4096-char bound must be rejected');
  });
  withEnv({ [TOKEN_ENV]: 'x'.repeat(4096) }, () => {
    assert.strictEqual(telemetryBearerToken(), 'x'.repeat(4096), 'a token exactly at the bound must be accepted');
  });

  console.log('ok: oversized token rejected, boundary value accepted');
}

function testEmptyTokenTreatedAsAbsent() {
  console.log('\n--- Test: an empty/whitespace-only token is treated as not configured ---');

  withEnv({ [TOKEN_ENV]: '   ' }, () => {
    assert.strictEqual(telemetryBearerToken(), undefined, 'whitespace-only token must not authenticate');
  });

  console.log('ok: whitespace-only token treated as absent');
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
    testNoTokenByDefault();
    testTokenReturnedWhenConfigured();
    testOversizedTokenRejected();
    testEmptyTokenTreatedAsAbsent();
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
