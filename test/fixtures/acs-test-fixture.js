import crypto from 'node:crypto';

// Repository-owned public test key. It is intentionally not a credential: the
// private half is never used by runtime tests, and managed-acs unit tests own
// their signing vector separately.
const rawPublicKey = Buffer.from('11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo', 'base64url');
const publicKeyDer = Buffer.concat([
  Buffer.from('302a300506032b6570032100', 'hex'),
  rawPublicKey,
]);

// Fail fast if the fixture is accidentally edited into an invalid SPKI key.
crypto.createPublicKey({ key: publicKeyDer, format: 'der', type: 'spki' });

export const TEST_ACS_KEY_ID = 'test-key-1';
export const TEST_ACS_PUBLIC_KEY = publicKeyDer.toString('base64url');

export function testAcsEnvironment(stateDirectory) {
  return {
    DESKTOP_COMMANDER_ACS_PUBLIC_KEY: TEST_ACS_PUBLIC_KEY,
    DESKTOP_COMMANDER_ACS_KEY_ID: TEST_ACS_KEY_ID,
    DESKTOP_COMMANDER_STATE_DIR: stateDirectory,
  };
}
