import { ControlStackError } from "@agent-control-stack/shared";
import {
  advanceMissionDispatch,
  iterateMissionDispatches,
  recordMissionDispatchObservation,
  type MissionRunnerResult
} from "@agent-control-stack/policy-gate";
import { SqliteWorkItemStore } from "@agent-control-stack/work-items";
import { createMissionRunnerClient, missionClientConfigFromEnv } from "./mission-client.js";

/** Uses the existing worker timer and mission runner; no gateway-side execution or extra daemon. */
export async function resumeDispatchedMissions(
  dbPath: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<MissionRunnerResult[]> {
  if (env.ACS_MISSION_DISPATCH_ENABLED !== "1") return [];
  const actorId = env.ACS_MISSION_EXECUTING_ACTOR_ID?.trim();
  if (!actorId)
    throw new ControlStackError("mission_dispatch_executor_missing", "configure the mission executor identity");
  const config = missionClientConfigFromEnv(env);
  const client = createMissionRunnerClient(config);
  const store = new SqliteWorkItemStore(dbPath);
  try {
    const results: MissionRunnerResult[] = [];
    let advanced = 0;
    // Oldest first, bounded work per timer tick. Terminal progress is owned by ACS.
    for (const request of iterateMissionDispatches(store)) {
      if (request.executingActorId !== actorId) continue;
      try {
        const record = store.getChangeSet(request.missionId);
        const progress = store.getChangeSetProgress(request.missionId, request.expectedManifestHash);
        if (
          progress.completion ||
          (store.getChangeSet(request.missionId)?.snapshot.definition.constraints.failureBehavior === "stop" &&
            progress.operations.some((operation) =>
              ["failed", "blocked", "needs_reconciliation"].includes(operation.status)
            ))
        )
          continue;
        if (!record || record.manifestHash !== request.expectedManifestHash)
          throw new ControlStackError("mission_dispatch_snapshot_mismatch", "queued mission snapshot changed");
        if (
          record.snapshot.definition.operations.some(
            (operation) => operation.runtime === "sandbox" || !config.runtimes[operation.runtime]
          )
        )
          throw new ControlStackError(
            "mission_runtime_unconfigured",
            "a planned runtime is not configured for this worker"
          );
        // Running/reviewing missions consume no new scheduler capacity. Do not
        // let ten paused missions starve a later ready mission in the same tick.
        const ready = record.snapshot.definition.operations.some(
          (operation) =>
            ["not_permitted", "not_started"].includes(
              progress.operations.find((state) => state.operationId === operation.operationId)!.status
            ) &&
            operation.dependsOn.every(
              (dependency) =>
                progress.operations.find((state) => state.operationId === dependency)?.status === "succeeded"
            )
        );
        if (!ready && !progress.operations.every((operation) => operation.status === "succeeded")) continue;
        const result = await advanceMissionDispatch(store, client.ports, request, actorId);
        results.push(result);
        advanced += 1;
      } catch (error) {
        const code = error instanceof ControlStackError ? error.code : "mission_dispatch_failed";
        recordMissionDispatchObservation(store, request, { status: "blocked", code });
        results.push({
          missionId: request.missionId,
          status: "blocked",
          code: error instanceof ControlStackError ? error.code : "mission_dispatch_failed"
        });
      }
      if (advanced >= 10) break;
    }
    return results;
  } finally {
    store.close();
    await client.close();
  }
}
