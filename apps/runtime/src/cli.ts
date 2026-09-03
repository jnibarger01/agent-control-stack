import { installRuntimeShutdown } from "./lifecycle.js";
import { loadRuntimeConfig } from "./config.js";
import { startAcsRuntime } from "./index.js";

if (process.argv[2] !== "serve") {
  console.error("Usage: acs serve");
  process.exitCode = 1;
} else {
  const runtime = await startAcsRuntime(loadRuntimeConfig());
  installRuntimeShutdown(runtime);
}
