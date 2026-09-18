import { loadBridgeDaemonConfig, runBridgeDaemon } from "./daemon.js";

const controller = new AbortController();
const stop = () => controller.abort();

process.once("SIGINT", stop);
process.once("SIGTERM", stop);

try {
  const config = loadBridgeDaemonConfig();
  await runBridgeDaemon(config, { signal: controller.signal });
} catch {
  console.error("bridge.start_failed");
  process.exitCode = 1;
} finally {
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
}
