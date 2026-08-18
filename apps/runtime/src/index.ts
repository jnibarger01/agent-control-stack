import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { SqliteWorkItemStore } from "@agent-control-stack/work-items";
import { loadRuntimeConfig, type RuntimeConfig } from "./config.js";

export type RuntimeComponentName =
  "gateway" | "controlPlane" | "scheduler" | "actorDiscovery" | "executionWorker" | "reconciler";
export type RuntimeComponentState = "starting" | "ready" | "degraded" | "stopped";

export interface RuntimeStatus {
  ok: boolean;
  startedAt: string;
  components: Record<RuntimeComponentName, { state: RuntimeComponentState; detail?: string }>;
  actors: { registered: number; agents: number; available: number; degraded: number };
}

export interface AcsRuntime {
  readonly status: RuntimeStatus;
  close(): Promise<void>;
}

export interface RuntimeDependencies {
  spawn?: typeof spawn;
  createServer?: typeof createServer;
  storeFactory?: (
    dbPath: string
  ) => Pick<
    SqliteWorkItemStore,
    | "health"
    | "listActors"
    | "listRegistryAgents"
    | "failExpiredLeases"
    | "reconcileStaleAgents"
    | "reconcileStaleTunnelSessions"
    | "close"
  >;
  scriptPaths?: Partial<Record<"gateway" | "scheduler" | "worker", string>>;
  logger?: Pick<Console, "error" | "info">;
}

export async function startAcsRuntime(
  config: RuntimeConfig = loadRuntimeConfig(),
  dependencies: RuntimeDependencies = {}
): Promise<AcsRuntime> {
  const start = dependencies.spawn ?? spawn;
  const createStatusServer = dependencies.createServer ?? createServer;
  const store = (dependencies.storeFactory ?? ((dbPath) => new SqliteWorkItemStore(dbPath)))(config.dbPath);
  const logger = dependencies.logger ?? console;
  const status: RuntimeStatus = {
    ok: false,
    startedAt: new Date().toISOString(),
    components: componentStates("starting"),
    actors: { registered: 0, agents: 0, available: 0, degraded: 0 }
  };
  const childProcesses = new Set<ChildProcess>();
  let closed = false;
  const busy = new Set<"scheduler" | "worker">();

  const run = (name: "scheduler" | "worker"): void => {
    if (closed || busy.has(name)) return;
    busy.add(name);
    const child = start(process.execPath, [scriptPath(name, dependencies)], {
      env: { ...process.env, ACS_DB_PATH: config.dbPath, ACS_WORKER_ID: config.workerId },
      stdio: "inherit"
    });
    childProcesses.add(child);
    child.once("error", (error) =>
      setComponent(status, name === "worker" ? "executionWorker" : "scheduler", "degraded", error.message)
    );
    child.once("exit", (code) => {
      childProcesses.delete(child);
      busy.delete(name);
      if (!closed && code !== 0)
        setComponent(
          status,
          name === "worker" ? "executionWorker" : "scheduler",
          "degraded",
          `exit ${code ?? "signal"}`
        );
    });
  };

  const discoverAndReconcile = (): void => {
    try {
      store.failExpiredLeases();
      store.reconcileStaleTunnelSessions();
      store.reconcileStaleAgents();
      const agents = store.listRegistryAgents();
      status.actors = {
        registered: store.listActors().length,
        agents: agents.length,
        available: agents.filter((agent) => agent.status === "AVAILABLE").length,
        degraded: agents.filter((agent) => agent.status === "DEGRADED").length
      };
      setComponent(status, "controlPlane", store.health().ok ? "ready" : "degraded");
      setComponent(status, "actorDiscovery", "ready");
      setComponent(status, "reconciler", "ready");
    } catch (error) {
      const detail = error instanceof Error ? error.message : "runtime reconciliation failed";
      setComponent(status, "controlPlane", "degraded", detail);
      setComponent(status, "actorDiscovery", "degraded", detail);
      setComponent(status, "reconciler", "degraded", detail);
    }
  };

  const gateway = start(process.execPath, [scriptPath("gateway", dependencies)], {
    env: { ...process.env, ACS_DB_PATH: config.dbPath, HOST: config.gatewayHost, PORT: String(config.gatewayPort) },
    stdio: "inherit"
  });
  childProcesses.add(gateway);
  gateway.once("error", (error) => setComponent(status, "gateway", "degraded", error.message));
  gateway.once("exit", (code) => {
    childProcesses.delete(gateway);
    if (!closed) setComponent(status, "gateway", "degraded", `exit ${code ?? "signal"}`);
  });
  await waitForGateway(config, status);
  setComponent(status, "scheduler", "ready");
  setComponent(status, "executionWorker", "ready");
  discoverAndReconcile();
  run("scheduler");
  run("worker");

  const schedulerTimer = setInterval(() => run("scheduler"), config.schedulerIntervalMs);
  const workerTimer = setInterval(() => run("worker"), config.workerIntervalMs);
  const reconcileTimer = setInterval(discoverAndReconcile, config.reconcileIntervalMs);
  const statusServer = createStatusServer((request, response) => {
    const path = request.url?.split("?")[0];
    if (path === "/livez") return respond(response, 200, { ok: true, status: "alive" });
    if (path === "/readyz") return respond(response, status.ok ? 200 : 503, status);
    if (path === "/status") return respond(response, 200, status);
    return respond(response, 404, { error: "not found" });
  });
  await new Promise<void>((resolve, reject) =>
    statusServer.listen(config.statusPort, "127.0.0.1", () => resolve()).once("error", reject)
  );
  logger.info({ statusPort: config.statusPort, gatewayPort: config.gatewayPort }, "ACS runtime started");

  return {
    status,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      clearInterval(schedulerTimer);
      clearInterval(workerTimer);
      clearInterval(reconcileTimer);
      for (const child of childProcesses) child.kill("SIGTERM");
      await new Promise<void>((resolve) => statusServer.close(() => resolve()));
      store.close();
      for (const name of Object.keys(status.components) as RuntimeComponentName[])
        setComponent(status, name, "stopped");
      status.ok = false;
    }
  };
}

function componentStates(state: RuntimeComponentState): RuntimeStatus["components"] {
  return {
    gateway: { state },
    controlPlane: { state },
    scheduler: { state },
    actorDiscovery: { state },
    executionWorker: { state },
    reconciler: { state }
  };
}

function setComponent(
  status: RuntimeStatus,
  name: RuntimeComponentName,
  state: RuntimeComponentState,
  detail?: string
): void {
  status.components[name] = detail ? { state, detail } : { state };
  status.ok = Object.values(status.components).every((component) => component.state === "ready");
}

function scriptPath(name: "gateway" | "scheduler" | "worker", dependencies: RuntimeDependencies): string {
  return dependencies.scriptPaths?.[name] ?? new URL(`../../${name}/dist/cli.js`, import.meta.url).pathname;
}

function respond(response: import("node:http").ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function waitForGateway(config: RuntimeConfig, status: RuntimeStatus): Promise<void> {
  const url = `http://${gatewayHostForUrl(config.gatewayHost)}:${config.gatewayPort}/readyz`;
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        setComponent(status, "gateway", "ready");
        return;
      }
    } catch {
      // The status endpoint remains available after startup, so callers can
      // distinguish a temporarily starting gateway from a healthy one.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  setComponent(status, "gateway", "degraded", "gateway readiness probe timed out");
}

function gatewayHostForUrl(host: string): string {
  return host === "::1" ? "[::1]" : host;
}
