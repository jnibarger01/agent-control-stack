import assert from 'node:assert/strict';
import { getToolContract, listToolContracts } from '../dist/tools/registry.js';
import { isManagedAcsToolName } from '../dist/managed-acs.js';

const contracts = listToolContracts();
assert.ok(contracts.length > 0);
assert.equal(new Set(contracts.map((contract) => contract.name)).size, contracts.length);

for (const contract of contracts) {
  assert.equal(contract.args !== undefined, true, `${contract.name} must have an argument schema`);
  if (isManagedAcsToolName(contract.name)) {
    assert.ok(contract.managedAcs, `${contract.name} must expose its managed ACS policy`);
  }
}

assert.equal(getToolContract('does-not-exist'), undefined);
console.log('tool registry contracts and managed ACS policy alignment passed');
