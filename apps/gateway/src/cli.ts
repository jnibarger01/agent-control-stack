import { ProductionConfigError, reportProductionConfigFailure } from "./production-config.js";
import { startGateway } from "./server.js";
import { installGracefulShutdown } from "./lifecycle.js";

try {
  const app = await startGateway();
  installGracefulShutdown(app);
} catch (error) {
  if (error instanceof ProductionConfigError) {
    reportProductionConfigFailure(error);
    process.exit(1);
  }
  throw error;
}
