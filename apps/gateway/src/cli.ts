import { startGateway } from "./server.js";
import { installGracefulShutdown } from "./lifecycle.js";

const app = await startGateway();
installGracefulShutdown(app);
