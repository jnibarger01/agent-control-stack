import type { FastifyInstance } from "fastify";

export interface GatewayProcess {
  once(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  exit(code?: number): never;
  exitCode?: string | number | null;
}

export function installGracefulShutdown(
  app: Pick<FastifyInstance, "close" | "log">,
  runtime: GatewayProcess = process,
  timeoutMs = 10_000
): void {
  let shuttingDown = false;

  const shutdown = (signal: "SIGINT" | "SIGTERM") => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, "gateway shutdown started");
    const timeout = setTimeout(() => {
      app.log.error({ signal, timeoutMs }, "gateway shutdown timed out");
      runtime.exit(1);
    }, timeoutMs);
    timeout.unref();

    void app.close().then(
      () => {
        clearTimeout(timeout);
        runtime.exitCode = 0;
        app.log.info({ signal }, "gateway shutdown complete");
      },
      (error: unknown) => {
        clearTimeout(timeout);
        app.log.error({ error, signal }, "gateway shutdown failed");
        runtime.exitCode = 1;
      }
    );
  };

  runtime.once("SIGINT", () => shutdown("SIGINT"));
  runtime.once("SIGTERM", () => shutdown("SIGTERM"));
}
