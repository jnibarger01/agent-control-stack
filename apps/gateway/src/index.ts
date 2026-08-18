import { startGateway } from "./server.js";

export { installGracefulShutdown } from "./lifecycle.js";
export { buildGateway, startGateway } from "./server.js";

if (process.argv[1] && import.meta.url.endsWith(process.argv[1])) {
  await startGateway();
}
