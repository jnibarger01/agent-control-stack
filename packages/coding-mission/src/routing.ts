import {
  NIMBLE_ROUTING_ALGORITHM_VERSION,
  routeNimbleActor,
  type ActorNimbleRoutingInput,
  type NimbleClientOptions
} from "@agent-control-stack/actor-router";
import { ControlStackError } from "@agent-control-stack/shared";

/** Authoritative coding-mission route. Eligibility is ACS; Nimble ranks the eligible set. */
export async function routeCodingOperationWithNimble(
  input: ActorNimbleRoutingInput,
  client: NimbleClientOptions
): Promise<{ workerId: string; algorithm: string; decision: unknown }> {
  const routed = await routeNimbleActor(input, client);
  if (routed.state !== "SELECTED" || !routed.selectedAgentId) {
    throw new ControlStackError("coding_mission_route_unselected", `Nimble did not select a worker (${routed.state})`);
  }
  return {
    workerId: routed.selectedAgentId,
    algorithm: NIMBLE_ROUTING_ALGORITHM_VERSION,
    decision: {
      state: routed.state,
      selectedAgentId: routed.selectedAgentId,
      scores: routed.decision.scores,
      eligible: routed.decision.eligible,
      candidates: routed.candidates
    }
  };
}
