import { startGateway } from "./server.js";

export { installGracefulShutdown } from "./lifecycle.js";
export { buildGateway, startGateway } from "./server.js";
export { buildHostedGateway } from "./hosted/app.js";

// Vercel's Fastify runtime consumes the module's default export. Keep the
// privileged/local SQLite gateway completely outside that hosted bootstrap.
const hostedApp = process.env.VERCEL
  ? await import("./hosted/app.js").then(({ buildHostedGateway }) => buildHostedGateway())
  : undefined;

export default hostedApp;

if (process.argv[1] && import.meta.url.endsWith(process.argv[1])) {
  await startGateway();
}
