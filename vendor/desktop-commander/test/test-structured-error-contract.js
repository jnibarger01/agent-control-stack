import assert from 'assert';

import { createErrorResponse } from '../dist/error-handlers.js';

function testBackwardCompatibleShape() {
  console.log('\n--- Test: createErrorResponse(message) stays backward compatible ---');

  const result = createErrorResponse('Something went wrong');

  // Every pre-existing call site calls this with just a message and expects
  // exactly this content/isError shape — must not change.
  assert.deepStrictEqual(result.content, [{ type: 'text', text: 'Error: Something went wrong' }]);
  assert.strictEqual(result.isError, true);

  console.log('ok: content/isError shape unchanged for message-only callers');
}

function testStructuredFieldsDefaults() {
  console.log('\n--- Test: structured error info has sane defaults when unspecified ---');

  const result = createErrorResponse('Oops');
  const errorInfo = result._meta?.errorInfo;

  assert.ok(errorInfo, '_meta.errorInfo must be present');
  assert.strictEqual(errorInfo.causeCategory, 'unknown');
  assert.strictEqual(errorInfo.code, 'UNKNOWN');
  assert.strictEqual(errorInfo.retryable, false);
  assert.strictEqual(typeof errorInfo.correlationId, 'string');
  assert.ok(errorInfo.correlationId.length > 0);

  console.log('ok: defaults are unknown/UNKNOWN/non-retryable with a correlation id');
}

function testStructuredFieldsHonored() {
  console.log('\n--- Test: explicit structured fields are honored ---');

  const result = createErrorResponse('Path not allowed: /etc/shadow', {
    causeCategory: 'permission',
    code: 'PATH_NOT_ALLOWED',
    retryable: false,
  });

  const errorInfo = result._meta.errorInfo;
  assert.strictEqual(errorInfo.causeCategory, 'permission');
  assert.strictEqual(errorInfo.code, 'PATH_NOT_ALLOWED');
  assert.strictEqual(errorInfo.retryable, false);

  // The human-readable text must never be replaced by the structured fields —
  // it's what most current consumers actually read.
  assert.strictEqual(result.content[0].text, 'Error: Path not allowed: /etc/shadow');

  console.log('ok: explicit code/causeCategory/retryable flow through untouched');
}

function testCodeDefaultsFromCauseCategory() {
  console.log('\n--- Test: code defaults to the upper-cased causeCategory when omitted ---');

  const result = createErrorResponse('Bad input', { causeCategory: 'validation' });
  assert.strictEqual(result._meta.errorInfo.code, 'VALIDATION');

  console.log('ok: code derived from causeCategory');
}

function testCorrelationIdsAreUnique() {
  console.log('\n--- Test: each error response gets its own correlation id ---');

  const a = createErrorResponse('first');
  const b = createErrorResponse('second');
  assert.notStrictEqual(a._meta.errorInfo.correlationId, b._meta.errorInfo.correlationId);

  console.log('ok: correlation ids are unique per call');
}

function testNoSecretsInStructuredFields() {
  console.log('\n--- Test: structured fields never carry the raw message/secrets ---');

  const result = createErrorResponse('token=sk-super-secret-value should stay in the message only', {
    causeCategory: 'internal',
  });

  const serializedErrorInfo = JSON.stringify(result._meta.errorInfo);
  assert.ok(
    !serializedErrorInfo.includes('sk-super-secret-value'),
    'structured errorInfo must only carry code/category/retryable/correlationId, never message content'
  );

  console.log('ok: structured fields stay message-content-free');
}

export default async function runTests() {
  try {
    testBackwardCompatibleShape();
    testStructuredFieldsDefaults();
    testStructuredFieldsHonored();
    testCodeDefaultsFromCauseCategory();
    testCorrelationIdsAreUnique();
    testNoSecretsInStructuredFields();

    console.log('\nStructured error contract tests passed.');
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Structured error contract test failed:', message);
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
