// Discovery lives in @agent-control-stack/work-items so the gateway can run it too.
export {
  CANONICAL_DISCOVERY_TARGETS,
  DISCOVERY_ERROR_MAX_LENGTH,
  DISCOVERY_PROBE_TIMEOUT_MS,
  SYSTEM_BOOTSTRAP_ACTOR_ID,
  discoverLocalActors,
  isWorkerCapacityTarget,
  probeExecutableVersion,
  resolveExecutableOnPath,
  sanitizeDiscoveryError
} from "@agent-control-stack/work-items";
export type {
  CanonicalDiscoveryTarget,
  DiscoverLocalActorsDeps,
  DiscoverLocalActorsOptions,
  DiscoveryOutcome,
  DiscoveryResult,
  ProbeResult
} from "@agent-control-stack/work-items";
