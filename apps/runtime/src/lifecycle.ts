import type { AcsRuntime } from "./index.js";

export function installRuntimeShutdown(runtime: AcsRuntime, processRef: NodeJS.Process = process): void {
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void runtime.close().then(
      () => {
        processRef.exitCode = 0;
      },
      () => {
        processRef.exitCode = 1;
      }
    );
  };
  processRef.once("SIGINT", shutdown);
  processRef.once("SIGTERM", shutdown);
}
