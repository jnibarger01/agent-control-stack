import { SqliteWorkItemStore, executionPlanSubjectInputHash } from "@agent-control-stack/work-items";
import { MissionAuthorityLedger, type GrantReader } from "./child-work.js";
import { CodingMissionStore } from "./store.js";
import { WorkUnitExecutionLedger } from "./worker-execution.js";

export interface GovernedExecutionOptions {
  /** The control-plane database. Work items, grants, the audit chain and mission runtime tables share this file. */
  dbPath: string;
  /** True only for an authenticated operator. Required: there is no default that trusts a caller-supplied identity. */
  verifyOperator(operatorId: string): boolean;
  /**
   * Maps a worker id to the actor its authority was issued to. Required, so a deployment states its worker identity
   * model instead of inheriting an identity mapping that would let any worker id name any actor.
   */
  resolveActor(workerId: string): string | undefined;
  clock?: () => string;
  claimTtlMs?: number;
}

export interface GovernedExecution {
  readonly missions: CodingMissionStore;
  readonly items: SqliteWorkItemStore;
  /** Binds missions to human-issued grants and admits narrowed child work. */
  readonly authority: MissionAuthorityLedger;
  /** The single dispatch gate; governed missions are checked against `authority` before any worker runs. */
  readonly dispatcher: WorkUnitExecutionLedger;
  close(): void;
}

/** The grant reader backed by the real control-plane store: canonical grant hash, audit-backed revocation. */
export function controlPlaneGrantReader(items: SqliteWorkItemStore): GrantReader {
  return {
    getAutonomousAuthority: (grantId) => items.getAutonomousAuthority(grantId),
    currentSubjectInputHash: (missionId) => {
      const item = items.get(missionId);
      return item ? executionPlanSubjectInputHash(item) : undefined;
    }
  };
}

/**
 * The composition root for governed execution. It is the only place that connects the dispatch gate to the real grant
 * store, so a dispatcher built here cannot run a governed mission without its authority being verified, and nothing
 * here can mint or widen authority: it only wires readers.
 */
export function createGovernedExecution(options: GovernedExecutionOptions): GovernedExecution {
  const items = new SqliteWorkItemStore(options.dbPath);
  let missions: CodingMissionStore | undefined;
  try {
    missions = new CodingMissionStore(options.dbPath);
    const authority = new MissionAuthorityLedger(missions, {
      grants: controlPlaneGrantReader(items),
      verifyOperator: options.verifyOperator,
      resolveActor: options.resolveActor,
      ...(options.clock ? { clock: options.clock } : {}),
      ...(options.claimTtlMs !== undefined ? { claimTtlMs: options.claimTtlMs } : {})
    });
    const dispatcher = new WorkUnitExecutionLedger(missions, { authority });
    const opened = missions;
    return {
      missions: opened,
      items,
      authority,
      dispatcher,
      close: () => {
        try {
          opened.close();
        } finally {
          items.close();
        }
      }
    };
  } catch (error) {
    try {
      missions?.close();
    } finally {
      items.close();
    }
    throw error;
  }
}
