import {
  PersistedSessionRecord,
  SessionStoreOptions,
  readAllSessionRecords,
  writeSessionRecord,
  pruneSessionRecords,
} from './session-store.js';
import { verifyProcessIdentity } from './utils/process-identity.js';
import { logger } from './utils/logger.js';

/**
 * Startup reconciliation (P2.1): decides what every persisted session
 * record means *right now*, against current OS process state — the only
 * point at which a durable record can become an actively-tracked
 * "recovered" session again.
 *
 * Idempotent by construction: classification is a pure function of
 * (record, current OS state) recomputed from scratch each call. A record
 * already in a terminal status (completed/terminated/stale) is left
 * exactly as-is — reconciliation only ever acts on 'running' records, and
 * a 'running' record that reconciles to 'recoverable' twice in a row
 * produces the same RecoveredSessionHandle both times (the caller is
 * responsible for not double-registering, e.g. by keying a Map on pid —
 * see terminal-manager.ts's registerRecoveredSession). Nothing here
 * mutates a record whose classification hasn't changed.
 */

export interface RecoveredSessionHandle {
  sessionId: string;
  pid: number;
  createdAt: string;
  command: string;
  cwd?: string;
  shell?: string;
}

export interface ReconciliationSummary {
  recovered: RecoveredSessionHandle[];
  markedStale: number;
  alreadyTerminal: number;
  corrupt: number;
  pruned: number;
}

export async function reconcileSessionsOnStartup(
  options: SessionStoreOptions = {},
): Promise<ReconciliationSummary> {
  const { valid, corrupt } = await readAllSessionRecords(options);

  const recovered: RecoveredSessionHandle[] = [];
  let markedStale = 0;
  let alreadyTerminal = 0;
  const updatedRecords: PersistedSessionRecord[] = [];

  for (const record of valid) {
    if (record.status !== 'running') {
      alreadyTerminal++;
      updatedRecords.push(record);
      continue;
    }

    const identity = await verifyProcessIdentity(record.pid, record.processStartFingerprint);

    if (identity === 'alive') {
      recovered.push({
        sessionId: record.sessionId,
        pid: record.pid,
        createdAt: record.createdAt,
        command: record.command,
        cwd: record.cwd,
        shell: record.shell,
      });
      updatedRecords.push(record); // still 'running' — untouched
      continue;
    }

    // 'dead', 'reused', or 'unverifiable': never adopt. A record that was
    // last known 'running' but can no longer be confidently matched to a
    // live process is 'stale', not silently promoted to 'completed' — we
    // have no exit code/signal for it (this server didn't observe its
    // exit), so pretending otherwise would fabricate data that was never
    // actually true.
    const staleReason = identity === 'reused'
      ? 'pid reused by a different process since last observed'
      : identity === 'unverifiable'
        ? 'process identity could not be verified'
        : 'process no longer exists';

    const staleRecord: PersistedSessionRecord = {
      ...record,
      status: 'stale',
      staleReason,
      updatedAt: new Date().toISOString(),
    };
    await writeSessionRecord(staleRecord, options);
    updatedRecords.push(staleRecord);
    markedStale++;
  }

  if (corrupt.length > 0) {
    logger.warning(`Desktop Commander: quarantined ${corrupt.length} corrupt session record(s) on startup`, {
      files: corrupt.map((c) => c.file),
    });
  }

  const pruned = await pruneSessionRecords(updatedRecords, new Date(), options);

  return { recovered, markedStale, alreadyTerminal, corrupt: corrupt.length, pruned };
}
