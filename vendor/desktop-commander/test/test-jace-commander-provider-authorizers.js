#!/usr/bin/env node
import assert from 'node:assert/strict';
import { JC_MANIFEST } from '../dist/jace-commander/manifest.generated.js';
import { JC_PROVIDER_IDS, JC_PROVIDER_REGISTRY, assertJcProviderCoverage, providerForTool } from '../dist/jace-commander/providers.js';
import { resolveJcAuthorizer } from '../dist/jace-commander/authorizers.js';

const names = JC_MANIFEST.tools.map((tool) => tool.name);
assertJcProviderCoverage(names);
assert.throws(() => assertJcProviderCoverage(['ping']));
assert.equal(JC_PROVIDER_IDS.length, 7);
assert.equal(Object.values(JC_PROVIDER_REGISTRY).flat().length, names.length);
assert.equal(new Set(Object.values(JC_PROVIDER_REGISTRY).flat()).size, names.length);
assert.equal(providerForTool('write_file'), 'jc.fs');
assert.equal(providerForTool('git_push'), 'jc.git');
assert.equal(providerForTool('privileged_exec'), 'jc.privileged');
assert.equal(providerForTool('acs_read'), 'acs');
assert.equal(providerForTool('mission_router_list'), 'jc.integration');
assert.equal(providerForTool('looptrace_verify'), 'jc.meta');
assert.equal(providerForTool('made_up'), undefined);
for (const tool of JC_MANIFEST.tools) {
  assert.equal(resolveJcAuthorizer(tool.name, 'managed'), 'acs-capability', tool.name);
  assert.equal(resolveJcAuthorizer(tool.name, 'standalone'),
    !tool.requiresApproval && tool.scopes.length > 0 && tool.scopes.every((scope) => scope.endsWith('.read')) ? 'local' : 'refused',
    tool.name);
}
assert.equal(resolveJcAuthorizer('made_up', 'managed'), 'refused');
assert.equal(resolveJcAuthorizer('write_file', 'managed', { defaultAuthorizer: 'local' }), 'refused');
assert.equal(resolveJcAuthorizer('privileged_exec', 'managed', { perTool: { privileged_exec: 'local' } }), 'refused');
assert.equal(resolveJcAuthorizer('git_status', 'managed', {
  defaultAuthorizer: 'acs-capability', perProvider: { 'jc.git': 'local' },
}), 'local');
assert.equal(resolveJcAuthorizer('git_status', 'managed', {
  perTool: { git_status: 'acs-capability' }, perProvider: { 'jc.git': 'local' },
}), 'acs-capability');
assert.equal(resolveJcAuthorizer('write_file', 'managed', {
  perTool: { write_file: 'admin-delegated' },
}), 'admin-delegated'); // Selection only; not execution authorization.
console.log('JC provider mapping and authorizer preset parity: passed');
