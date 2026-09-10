import assert from 'assert';

import {
  configManager,
  isTelemetryDisabledValue,
  isTelemetryEnabledValue,
  normalizeTelemetryEnabledValue,
} from '../dist/config-manager.js';
import { capture, isInsideUiOriginCall, runInUiOriginCallContext, sanitizeTelemetryProperties } from '../dist/utils/capture.js';
import { setConfigValue } from '../dist/tools/config.js';

function testTelemetryHelpers() {
  console.log('\n--- Test: telemetry helper behavior ---');

  assert.strictEqual(normalizeTelemetryEnabledValue('false'), false);
  assert.strictEqual(normalizeTelemetryEnabledValue(' true '), true);
  assert.strictEqual(normalizeTelemetryEnabledValue('disabled'), 'disabled');

  assert.strictEqual(isTelemetryDisabledValue(false), true);
  assert.strictEqual(isTelemetryDisabledValue('false'), true);
  assert.strictEqual(isTelemetryDisabledValue('FALSE'), true);
  assert.strictEqual(isTelemetryDisabledValue(true), false);
  assert.strictEqual(isTelemetryDisabledValue('true'), false);
  assert.strictEqual(isTelemetryEnabledValue(true), true);
  assert.strictEqual(isTelemetryEnabledValue('true'), true);
  assert.strictEqual(isTelemetryEnabledValue(undefined), false);
  assert.strictEqual(isTelemetryEnabledValue('enabled'), false);

  console.log('ok: telemetry helpers');
}

async function testConfigManagerCoercion() {
  console.log('\n--- Test: configManager telemetry coercion ---');

  await configManager.updateConfig({ telemetryEnabled: false });
  await configManager.setValue('telemetryEnabled', 'false');

  const telemetryEnabled = await configManager.getValue('telemetryEnabled');
  assert.strictEqual(telemetryEnabled, false);
  assert.strictEqual(typeof telemetryEnabled, 'boolean');

  console.log('ok: configManager coercion');
}

async function testSetConfigValueCoercion() {
  console.log('\n--- Test: set_config_value telemetry coercion ---');

  await configManager.updateConfig({ telemetryEnabled: false });
  const response = await setConfigValue({ key: 'telemetryEnabled', value: 'false' });

  assert.ok(response);
  assert.notStrictEqual(response.isError, true);

  const telemetryEnabled = await configManager.getValue('telemetryEnabled');
  assert.strictEqual(telemetryEnabled, false);
  assert.strictEqual(typeof telemetryEnabled, 'boolean');

  console.log('ok: set_config_value coercion');
}

/**
 * Regression test for issue #368:
 * When telemetryEnabled is stored as the string 'false' (which happens when
 * set via the MCP API), the capture path in captureBase must still treat it
 * as disabled. This test reproduces the exact codepath: write string 'false'
 * directly to config (bypassing setValue coercion), then read it back via
 * getValue and verify isTelemetryDisabledValue gates it.
 */
async function testCapturePathRespectsStringFalse() {
  console.log('\n--- Test: capture path respects string "false" (issue #368) ---');

  // Simulate the pre-fix bug scenario: telemetryEnabled stored as string 'false'
  // by writing directly through updateConfig (bypassing setValue normalization).
  await configManager.updateConfig({ telemetryEnabled: 'false' });

  // This is the exact check captureBase and sendToTelemetryProxy perform:
  const telemetryEnabled = await configManager.getValue('telemetryEnabled');
  assert.strictEqual(
    isTelemetryDisabledValue(telemetryEnabled),
    true,
    `isTelemetryDisabledValue should return true for stored value ${JSON.stringify(telemetryEnabled)} (type: ${typeof telemetryEnabled})`
  );

  console.log('ok: capture path respects string "false"');
}

async function testCapturePathRespectsStringFALSE() {
  console.log('\n--- Test: capture path respects string "FALSE" ---');

  await configManager.updateConfig({ telemetryEnabled: 'FALSE' });

  const telemetryEnabled = await configManager.getValue('telemetryEnabled');
  assert.strictEqual(
    isTelemetryDisabledValue(telemetryEnabled),
    true,
    `isTelemetryDisabledValue should return true for stored value ${JSON.stringify(telemetryEnabled)}`
  );

  console.log('ok: capture path respects string "FALSE"');
}

async function testCapturePathRespectsBooleanFalse() {
  console.log('\n--- Test: capture path respects boolean false ---');

  await configManager.updateConfig({ telemetryEnabled: false });

  const telemetryEnabled = await configManager.getValue('telemetryEnabled');
  assert.strictEqual(
    isTelemetryDisabledValue(telemetryEnabled),
    true,
    `isTelemetryDisabledValue should return true for stored value ${JSON.stringify(telemetryEnabled)}`
  );

  console.log('ok: capture path respects boolean false');
}

async function testCapturePathAllowsTrueValues() {
  console.log('\n--- Test: capture path allows true values ---');

  await configManager.updateConfig({ telemetryEnabled: true });
  let telemetryEnabled = await configManager.getValue('telemetryEnabled');
  assert.strictEqual(isTelemetryDisabledValue(telemetryEnabled), false, 'boolean true should not be disabled');

  await configManager.updateConfig({ telemetryEnabled: 'true' });
  telemetryEnabled = await configManager.getValue('telemetryEnabled');
  assert.strictEqual(isTelemetryDisabledValue(telemetryEnabled), false, 'string "true" should not be disabled');

  console.log('ok: capture path allows true values');
}

/**
 * Tool calls fired programmatically by the widget UIs (args.origin === 'ui')
 * run inside runInUiOriginCallContext, and capture() drops every event raised
 * while isInsideUiOriginCall() is true — so UI refresh churn (pull-by-path
 * reads, in-preview saves, link search) produces zero telemetry. This verifies
 * the AsyncLocalStorage mechanics that invariant depends on: the flag holds
 * across awaits, does not leak out, and does not bleed into interleaved calls.
 */
async function testDefaultOffAndNoEgress() {
  console.log('\\n--- Test: telemetry default-off and no client/network work ---');
  await configManager.updateConfig({ telemetryEnabled: undefined, clientId: undefined });
  await capture('test_default_off', { token: 'should-not-be-forwarded' });
  assert.strictEqual(await configManager.getValue('clientId'), undefined, 'disabled telemetry must not create a client ID');
  assert.deepStrictEqual(sanitizeTelemetryProperties({ token: 'secret', nested: { authorization: 'Bearer secret', ok: 'value' } }), { nested: { ok: 'value' } });
  console.log('ok: default-off/no-egress and secret redaction');
}

async function testExplicitOptInValidation() {
  console.log('\\n--- Test: telemetry requires explicit validated opt-in ---');
  await configManager.setValue('telemetryEnabled', 'true');
  assert.strictEqual(await configManager.getValue('telemetryEnabled'), true);
  assert.strictEqual(isTelemetryEnabledValue(await configManager.getValue('telemetryEnabled')), true);
  await assert.rejects(() => configManager.setValue('telemetryEnabled', 'yes'), /must be a boolean/);
  await configManager.setValue('telemetryEnabled', false);
  console.log('ok: explicit opt-in validation');
}

async function testUiOriginCallContext() {
  console.log('\n--- Test: UI-origin call context (zero telemetry for widget calls) ---');

  assert.strictEqual(isInsideUiOriginCall(), false, 'context should be off outside runInUiOriginCallContext');

  const observed = await runInUiOriginCallContext(async () => {
    const beforeAwait = isInsideUiOriginCall();
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { beforeAwait, afterAwait: isInsideUiOriginCall() };
  });
  assert.strictEqual(observed.beforeAwait, true, 'context should be on inside runInUiOriginCallContext');
  assert.strictEqual(observed.afterAwait, true, 'context should survive awaits');
  assert.strictEqual(isInsideUiOriginCall(), false, 'context should not leak after the wrapped call returns');

  // An agent call interleaving with an in-flight UI-origin call must not
  // inherit the UI flag (this is why it is AsyncLocalStorage, not a global).
  let releaseUiCall;
  const uiGate = new Promise((resolve) => { releaseUiCall = resolve; });
  const uiCall = runInUiOriginCallContext(async () => {
    await uiGate;
    return isInsideUiOriginCall();
  });
  const interleavedAgentFlag = isInsideUiOriginCall();
  releaseUiCall();
  assert.strictEqual(interleavedAgentFlag, false, 'concurrent non-UI code must not inherit the UI context');
  assert.strictEqual(await uiCall, true, 'UI-origin call keeps its context across interleaving');

  console.log('ok: UI-origin call context');
}

export default async function runTests() {
  const originalConfig = await configManager.getConfig();

  try {
    testTelemetryHelpers();
    await testConfigManagerCoercion();
    await testSetConfigValueCoercion();
    await testCapturePathRespectsStringFalse();
    await testCapturePathRespectsStringFALSE();
    await testCapturePathRespectsBooleanFalse();
    await testCapturePathAllowsTrueValues();
    await testDefaultOffAndNoEgress();
    await testExplicitOptInValidation();
    await testUiOriginCallContext();

    console.log('\nTelemetry handling tests passed.');
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Telemetry handling test failed:', message);
    if (error instanceof Error && error.stack) {
      console.error(error.stack);
    }
    return false;
  } finally {
    await configManager.updateConfig(originalConfig);
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
