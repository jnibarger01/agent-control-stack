import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  newSessionId,
  sessionSchemaVersion,
  writeSessionRecord,
  readSessionRecord,
  readAllSessionRecords,
  deleteSessionRecord,
  sessionsDirectory,
  selectRecordsToPrune,
  pruneSessionRecords,
  DEFAULT_RETENTION_POLICY,
} from '../dist/session-store.js';

function baseRecord(overrides = {}) {
  const now = new Date().toISOString();
  return {
    schemaVersion: sessionSchemaVersion(),
    sessionId: newSessionId(),
    pid: 12345,
    processStartFingerprint: 'linux:starttime:1000',
    command: 'echo hi',
    // cwd intentionally omitted (optional field) — JSON.stringify drops
    // `undefined` values, so a round-tripped record never has this key at
    // all rather than an explicit undefined; setting it here would make
    // the round-trip equality assertion below fail for the wrong reason.
    shell: 'true',
    ownerRuntimeId: 'runtime-test',
    createdAt: now,
    updatedAt: now,
    status: 'running',
    ...overrides,
  };
}

async function withTempStateDir(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-session-store-'));
  try {
    await fn({ stateDirectory: root });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function testAtomicWriteAndReadRoundTrip() {
  console.log('\n--- Test: write/read round-trips a session record exactly ---');
  await withTempStateDir(async (options) => {
    const record = baseRecord();
    await writeSessionRecord(record, options);

    const dirStat = await fs.stat(sessionsDirectory(options));
    assert.equal(dirStat.mode & 0o777, 0o700, 'sessions directory must be owner-only');

    const filePath = path.join(sessionsDirectory(options), `${record.sessionId}.json`);
    const fileStat = await fs.stat(filePath);
    assert.equal(fileStat.mode & 0o777, 0o600, 'session record file must be owner-only');

    const readBack = await readSessionRecord(record.sessionId, options);
    assert.deepEqual(readBack, record);
  });
  console.log('ok: round-trip preserves the record exactly, with owner-only permissions');
}

async function testNoPartiallyWrittenRecordIsEverObservable() {
  console.log('\n--- Test: a crash mid-write never leaves a half-written record visible ---');
  await withTempStateDir(async (options) => {
    const record = baseRecord();
    await writeSessionRecord(record, options);

    // Simulate "the process died mid-write": a temp file sits next to the
    // real record but was never rename()'d into place.
    const dir = sessionsDirectory(options);
    const orphanTemp = path.join(dir, `${record.sessionId}.json.99999.${crypto.randomUUID()}.tmp`);
    await fs.writeFile(orphanTemp, '{ "schemaVersion": 1, "trunc');

    const { valid, corrupt } = await readAllSessionRecords(options);
    assert.equal(valid.length, 1, 'the orphaned .tmp file must never be read as a session record');
    assert.deepEqual(valid[0], record, 'the real record must be exactly what was last successfully written');
    assert.equal(corrupt.length, 0, 'a .tmp file is not a corrupt *.json record — it is simply ignored');
  });
  console.log('ok: only the completed rename() target is ever treated as a record');
}

async function testCorruptRecordFailsClosed() {
  console.log('\n--- Test: corrupt/invalid persisted state fails closed ---');
  await withTempStateDir(async (options) => {
    const dir = sessionsDirectory(options);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });

    const truncatedId = crypto.randomUUID();
    await fs.writeFile(path.join(dir, `${truncatedId}.json`), '{ "schemaVersion": 1, "pid": 1, "trunc');

    const wrongVersionId = crypto.randomUUID();
    await fs.writeFile(
      path.join(dir, `${wrongVersionId}.json`),
      JSON.stringify(baseRecord({ sessionId: wrongVersionId, schemaVersion: 999 })),
    );

    const goodRecord = baseRecord();
    await writeSessionRecord(goodRecord, options);

    const { valid, corrupt } = await readAllSessionRecords(options);
    assert.equal(valid.length, 1, 'only the well-formed record is returned as valid');
    assert.equal(valid[0].sessionId, goodRecord.sessionId);
    assert.equal(corrupt.length, 2, 'both malformed records are reported, never silently dropped');

    // Quarantined: no longer visible on a subsequent read, and the raw file
    // still exists on disk (audit trail) but is not a *.json file anymore.
    const { valid: secondRead } = await readAllSessionRecords(options);
    assert.equal(secondRead.length, 1, 'quarantining is stable across repeated reads');

    const remainingFiles = await fs.readdir(dir);
    assert.ok(remainingFiles.some((f) => f.includes(truncatedId) && f.endsWith('.corrupt')));
    assert.ok(remainingFiles.some((f) => f.includes(wrongVersionId) && f.endsWith('.corrupt')));

    // A point-read of a quarantined id must also report "not found", not throw.
    const pointRead = await readSessionRecord(truncatedId, options);
    assert.equal(pointRead, undefined);
  });
  console.log('ok: corrupt records are quarantined, reported, and never treated as valid');
}

async function testDeleteIsIdempotent() {
  console.log('\n--- Test: deleting a session record is idempotent ---');
  await withTempStateDir(async (options) => {
    const record = baseRecord();
    await writeSessionRecord(record, options);
    await deleteSessionRecord(record.sessionId, options);
    assert.equal(await readSessionRecord(record.sessionId, options), undefined);
    // Deleting again (already gone) must not throw.
    await deleteSessionRecord(record.sessionId, options);
  });
  console.log('ok: delete is safe to call on an already-deleted record');
}

function testRetentionByAge() {
  console.log('\n--- Test: bounded retention prunes old terminal records by age ---');
  const now = new Date('2026-01-02T00:00:00.000Z');
  const old = baseRecord({ status: 'completed', updatedAt: '2026-01-00T23:00:00.000Z'.replace('00T', '01T') });
  // (construct a clearly-25h-old timestamp explicitly, avoid date-string edge cases)
  old.updatedAt = new Date(now.getTime() - 25 * 60 * 60 * 1000).toISOString();
  const recent = baseRecord({ status: 'completed', updatedAt: new Date(now.getTime() - 1 * 60 * 60 * 1000).toISOString() });
  const stillRunning = baseRecord({ status: 'running', updatedAt: new Date(now.getTime() - 100 * 60 * 60 * 1000).toISOString() });

  const toPrune = selectRecordsToPrune([old, recent, stillRunning], now, DEFAULT_RETENTION_POLICY);
  const prunedIds = new Set(toPrune.map((r) => r.sessionId));

  assert.ok(prunedIds.has(old.sessionId), 'a terminal record past maxAgeMs must be pruned');
  assert.ok(!prunedIds.has(recent.sessionId), 'a recent terminal record must survive');
  assert.ok(!prunedIds.has(stillRunning.sessionId), 'a running record is never pruned by age, however old');

  console.log('ok: age-based retention prunes only old terminal records, never running ones');
}

function testRetentionByCount() {
  console.log('\n--- Test: bounded retention caps total terminal record count ---');
  const now = new Date('2026-01-02T00:00:00.000Z');
  const policy = { maxAgeMs: 365 * 24 * 60 * 60 * 1000, maxCount: 3 };
  const records = Array.from({ length: 5 }, (_, i) =>
    baseRecord({ status: 'completed', updatedAt: new Date(now.getTime() - (5 - i) * 1000).toISOString() })
  );
  // records[0] is oldest, records[4] is newest.

  const toPrune = selectRecordsToPrune(records, now, policy);
  assert.equal(toPrune.length, 2, 'exactly enough oldest records are pruned to reach maxCount');
  const prunedIds = new Set(toPrune.map((r) => r.sessionId));
  assert.ok(prunedIds.has(records[0].sessionId) && prunedIds.has(records[1].sessionId), 'the two oldest are pruned');
  assert.ok(!prunedIds.has(records[4].sessionId), 'the newest record survives');

  console.log('ok: count-based retention prunes the oldest records first');
}

async function testRetentionIsDeterministicOnRepeatedRuns() {
  console.log('\n--- Test: repeated pruning converges and stays bounded ---');
  await withTempStateDir(async (options) => {
    const now = new Date();
    for (let i = 0; i < 10; i++) {
      await writeSessionRecord(
        baseRecord({ status: 'completed', updatedAt: new Date(now.getTime() - i * 1000).toISOString() }),
        options,
      );
    }
    const policy = { maxAgeMs: 365 * 24 * 60 * 60 * 1000, maxCount: 4 };

    const first = (await readAllSessionRecords(options)).valid;
    const prunedFirst = await pruneSessionRecords(first, now, options, policy);
    assert.equal(prunedFirst, 6);

    const afterFirst = (await readAllSessionRecords(options)).valid;
    assert.equal(afterFirst.length, 4, 'bounded to maxCount after one pruning pass');

    // Re-running with no new records must be a no-op (idempotent).
    const prunedSecond = await pruneSessionRecords(afterFirst, now, options, policy);
    assert.equal(prunedSecond, 0);
    const afterSecond = (await readAllSessionRecords(options)).valid;
    assert.equal(afterSecond.length, 4);
  });
  console.log('ok: pruning converges to the bound and is idempotent thereafter');
}

export default async function runTests() {
  try {
    await testAtomicWriteAndReadRoundTrip();
    await testNoPartiallyWrittenRecordIsEverObservable();
    await testCorruptRecordFailsClosed();
    await testDeleteIsIdempotent();
    testRetentionByAge();
    testRetentionByCount();
    await testRetentionIsDeterministicOnRepeatedRuns();

    console.log('\nSession store tests passed.');
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Session store test failed:', message);
    if (error instanceof Error && error.stack) console.error(error.stack);
    return false;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runTests().then((success) => process.exit(success ? 0 : 1));
}
