import { ProductionConfigError, reportProductionConfigFailure } from "./production-config.js";
import { startGateway } from "./server.js";

export {
  installGracefulShutdown,
  ShutdownController,
  waitForLeaseDrain,
  guardWorkItemClaimTools,
  resolveDrainTimeoutMs,
  resolveShutdownTimeoutMs,
  GATEWAY_SHUTTING_DOWN_CODE,
  SHUTDOWN_DRAIN_METRIC
} from "./lifecycle.js";
export { buildGateway, startGateway } from "./server.js";
export {
  ProductionConfigError,
  isStrictConfigMode,
  reportProductionConfigFailure,
  validateProductionConfig
} from "./production-config.js";

if (process.argv[1] && import.meta.url.endsWith(process.argv[1])) {
  try {
    await startGateway();
  } catch (error) {
    if (error instanceof ProductionConfigError) {
      reportProductionConfigFailure(error);
      process.exit(1);
    }
    throw error;
  }
}
