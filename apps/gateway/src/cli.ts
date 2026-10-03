import { ProductionConfigError, reportProductionConfigFailure } from "./production-config.js";
import { startGateway } from "./server.js";
import { installGracefulShutdown, resolveDrainTimeoutMs, resolveShutdownTimeoutMs } from "./lifecycle.js";

const DEFAULT_ACTOR_DISCOVERY_INTERVAL_MS = 60_000;

/** ACS_ACTOR_DISCOVERY_INTERVAL_MS: probe cadence in ms; 0 turns the loop off. Default 60s (heartbeat TTL is 15 min). */
function resolveActorDiscoveryIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ACS_ACTOR_DISCOVERY_INTERVAL_MS?.trim();
  if (!raw) return DEFAULT_ACTOR_DISCOVERY_INTERVAL_MS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error("ACS_ACTOR_DISCOVERY_INTERVAL_MS must be a non-negative integer (0 disables)");
  }
  return value;
}

try {
  const app = await startGateway({ actorDiscovery: { intervalMs: resolveActorDiscoveryIntervalMs() } });
  const hooks = app.acsShutdown;
  installGracefulShutdown(app, {
    timeoutMs: resolveShutdownTimeoutMs(),
    drainTimeoutMs: resolveDrainTimeoutMs(),
    shutdownController: hooks?.controller,
    countActiveLeases: hooks?.countActiveLeases,
    failExpiredLeases: hooks?.failExpiredLeases,
    onDrainStart: (info) => hooks?.recordDrainStart(info),
    onDrainFinish: (info) => hooks?.recordDrainFinish(info)
  });
} catch (error) {
  if (error instanceof ProductionConfigError) {
    reportProductionConfigFailure(error);
    process.exit(1);
  }
  throw error;
}
