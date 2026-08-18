import { runSkillsCommand } from "@agent-control-stack/procedural-learning";
import { installGracefulShutdown, startGateway } from "@agent-control-stack/gateway";
import { MachineController, loadMachineControllerConfig } from "@agent-control-stack/machine-controller";
import { McpStdioServer } from "@agent-control-stack/mcp";
import { runSchedulerOnce } from "@agent-control-stack/scheduler";
import { DEFAULT_HEARTBEAT_TTL_MS, SqliteWorkItemStore } from "@agent-control-stack/work-items";
import { runWorkerOnce } from "@agent-control-stack/worker";
import { listAvailableActors } from "./available-actors.js";
import { discoverLocalActors as runLocalActorDiscovery } from "./discover-actors.js";
import { ACS_CLI_VERSION, ACS_HELP, AcsUsageError, parseAcsArgs, type AcsCommand } from "./parse.js";

export interface AcsIo {
  stdout: { write(chunk: string): void };
  stderr: { write(chunk: string): void };
}

export interface AcsAdapters {
  discoverLocalActors: () => Promise<void> | void;
  listAvailableActors: typeof listAvailableActors;
  runWorkerOnce: typeof runWorkerOnce;
  runSchedulerOnce: typeof runSchedulerOnce;
  startMcp: (args: string[]) => void;
  startGateway: () => Promise<void>;
  readStatus: () => { health: { ok: boolean }; audit: { ok: boolean } };
  listPublications: () => unknown[];
}

const defaultIo: AcsIo = {
  stdout: { write: (chunk) => process.stdout.write(chunk) },
  stderr: { write: (chunk) => process.stderr.write(chunk) }
};

function configPathFromArgs(args: string[]): string | undefined {
  const index = args.indexOf("--config");
  return index >= 0 ? args[index + 1] : undefined;
}

export function startMcpFromArgs(args: string[]): void {
  const configPath = configPathFromArgs(args) ?? process.env.ACS_MCP_CONFIG;
  const config = loadMachineControllerConfig(configPath);
  new McpStdioServer(process.stdin, process.stdout, new MachineController(config)).start();
}

export async function startGatewayFromCli(): Promise<void> {
  const app = await startGateway();
  installGracefulShutdown(app);
}

export async function discoverConfiguredActors(): Promise<void> {
  const dbPath = process.env.ACS_DB_PATH ?? "storage/local.db";
  const store = new SqliteWorkItemStore(dbPath, { heartbeatTtlMs: DEFAULT_HEARTBEAT_TTL_MS });
  try {
    await runLocalActorDiscovery({ store });
  } finally {
    store.close();
  }
}

export function readControlPlaneStatus() {
  const dbPath = process.env.ACS_DB_PATH ?? "storage/local.db";
  const store = new SqliteWorkItemStore(dbPath, { heartbeatTtlMs: DEFAULT_HEARTBEAT_TTL_MS });
  try {
    return { health: store.health(), audit: store.verifyAuditChain() };
  } finally {
    store.close();
  }
}

export function listControlPlanePublications() {
  const store = new SqliteWorkItemStore(process.env.ACS_DB_PATH ?? "storage/local.db");
  try { return store.listPublications(); } finally { store.close(); }
}

export const defaultAcsAdapters: AcsAdapters = {
  discoverLocalActors: discoverConfiguredActors,
  listAvailableActors,
  runWorkerOnce,
  runSchedulerOnce,
  startMcp: startMcpFromArgs,
  startGateway: startGatewayFromCli,
  readStatus: readControlPlaneStatus,
  listPublications: listControlPlanePublications
};

async function executeCommand(command: AcsCommand, io: AcsIo, adapters: AcsAdapters): Promise<number> {
  switch (command.kind) {
    case "help":
      io.stdout.write(ACS_HELP);
      return 0;
    case "version":
      io.stdout.write(`${ACS_CLI_VERSION}\n`);
      return 0;
    case "actor-list-available": {
      await adapters.discoverLocalActors();
      const actors = adapters.listAvailableActors();
      if (command.json) {
        io.stdout.write(`${JSON.stringify(actors)}\n`);
      } else {
        io.stdout.write(
          actors.length === 0
            ? "No available actors.\n"
            : `${actors.map((actor) => `${actor.actor_id}\t${actor.role}\t${actor.agent_type}\tcapacity=${actor.capacity}`).join("\n")}\n`
        );
      }
      return 0;
    }
    case "worker": {
      const result = await adapters.runWorkerOnce();
      io.stdout.write(`${JSON.stringify(result)}\n`);
      return 0;
    }
    case "scheduler": {
      const result = await adapters.runSchedulerOnce();
      io.stdout.write(`${JSON.stringify(result)}\n`);
      return 0;
    }
    case "mcp":
      adapters.startMcp(command.forwarded);
      return 0;
    case "gateway":
      await adapters.startGateway();
      return 0;
    case "status": {
      const status = adapters.readStatus();
      io.stdout.write(command.json ? `${JSON.stringify(status)}\n` : `health=${status.health.ok} audit=${status.audit.ok}\n`);
      return status.health.ok && status.audit.ok ? 0 : 1;
    }
    case "doctor": {
      const status = adapters.readStatus();
      io.stdout.write(command.json ? `${JSON.stringify(status)}\n` : `health=${status.health.ok} audit=${status.audit.ok}\n`);
      return status.health.ok && status.audit.ok ? 0 : 1;
    }
    case "publication-list": {
      const publications = adapters.listPublications();
      io.stdout.write(command.json ? `${JSON.stringify(publications)}\n` : publications.length ? `${publications.map((publication) => JSON.stringify(publication)).join("\n")}\n` : "No publications.\n");
      return 0;
    }
    case "skills":
      return runSkillsCommand(command.args, io);
    default: {
      const _exhaustive: never = command;
      throw new Error(`unhandled command ${JSON.stringify(_exhaustive)}`);
    }
  }
}

export async function runAcsCli(
  args: string[],
  io: AcsIo = defaultIo,
  adapters: AcsAdapters = defaultAcsAdapters
): Promise<number> {
  try {
    return await executeCommand(parseAcsArgs(args), io, adapters);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stderr.write(`${message}\n`);
    if (error instanceof AcsUsageError) {
      io.stderr.write(ACS_HELP);
    }
    return 1;
  }
}
