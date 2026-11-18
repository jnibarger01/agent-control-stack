#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertRootControlledDirectory } from '../dist/privileged-core.js';

// In unprivileged bubblewrap user namespaces, host root is mapped to the
// overflow UID. The root helper never runs there; keep the guard fail-closed.
if (fs.statSync('/').uid === 0) {
  assert.doesNotThrow(() => assertRootControlledDirectory('/'));
} else {
  assert.throws(() => assertRootControlledDirectory('/'), (error) => error.code === 'PRIVILEGED_EXECUTABLE_UNTRUSTED');
}
const unsafe = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-untrusted-cwd-'));
try {
  assert.throws(() => assertRootControlledDirectory(unsafe), (error) => error.code === 'PRIVILEGED_EXECUTABLE_UNTRUSTED');
} finally {
  fs.rmSync(unsafe, { recursive: true, force: true });
}
console.log('root helper refuses untrusted working directory');
