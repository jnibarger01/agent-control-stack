#!/usr/bin/env node
/**
 * Runs every test/*.test.mjs in its own Node process (the suites are
 * self-contained scripts that exit non-zero on failure). Usage:
 *   node test/run-all.mjs [name-filter ...]
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// node test/run-all.mjs [filter ...] [--exclude name ...]
const argv = process.argv.slice(2);
const excludeAt = argv.indexOf('--exclude');
const filters = excludeAt >= 0 ? argv.slice(0, excludeAt) : argv;
const excluded = excludeAt >= 0 ? argv.slice(excludeAt + 1) : [];
const files = fs.readdirSync(here)
  .filter((name) => name.endsWith('.test.mjs'))
  .filter((name) => filters.length === 0 || filters.some((filter) => name.includes(filter)))
  .filter((name) => !excluded.some((filter) => name.includes(filter)))
  .sort();
const failed = [];
for (const file of files) {
  const started = Date.now();
  const result = spawnSync(process.execPath, [path.join(here, file)], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 300_000 });
  const ms = Date.now() - started;
  if (result.status === 0) {
    console.log(`ok    ${file} (${ms} ms)`);
  } else {
    failed.push(file);
    console.log(`FAIL  ${file} (exit ${result.status ?? result.signal}, ${ms} ms)`);
    process.stdout.write((result.stdout || '').split('\n').slice(-40).join('\n'));
    process.stdout.write((result.stderr || '').split('\n').slice(-40).join('\n'));
    console.log('');
  }
}
console.log(`\n${files.length - failed.length}/${files.length} suites passed`);
if (failed.length) {
  console.log(`failed: ${failed.join(', ')}`);
  process.exit(1);
}
