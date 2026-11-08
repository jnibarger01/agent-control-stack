#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const release = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bridge = path.join(release, 'dist', 'bridge.mjs');
assert.equal(fs.existsSync(bridge), true, 'installed release must contain a self-contained JC bridge');
const run = spawnSync(process.execPath, [bridge], {
  encoding: 'utf8',
  timeout: 5000,
  env: {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    BRIDGE_PROFILE: 'jace-commander',
    ACS_MANAGED_MODE: '1',
    JC_REQUIRE_INSTALLED_RELEASE: fs.existsSync(path.join(release, 'RELEASE.json')) ? '1' : '0',
    JC_RUNTIME_DIR: release,
  },
});
assert.equal(run.status, 1, run.stderr);
assert.match(run.stderr, /requires DC_GATEWAY_EXECUTION_TOKEN/);
assert.doesNotMatch(run.stderr, /Cannot find module|Dynamic require|ERR_MODULE_NOT_FOUND/);
console.log('packaged bridge loads without checkout imports and denies missing credentials');
