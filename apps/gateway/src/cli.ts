import { ProductionConfigError, reportProductionConfigFailure } from "./production-config.js";
import { startGateway } from "./server.js";
import {
  installGracefulShutdown,
  resolveDrainTimeoutMs,
  resolveShutdownTimeoutMs,
  startLeaseReaper
} from "./lifecycle.js";

try {
  const app = await startGateway();
  const hooks = app.acsShutdown;
  const leaseReaper = startLeaseReaper({
    reap: () => hooks?.failExpiredLeases() ?? 0,
    onRun: (info) => hooks?.recordLeaseReaperRun(info)
  });
  app.addHook("onClose", async () => leaseReaper.stop());
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
