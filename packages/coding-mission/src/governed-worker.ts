import { ControlStackError } from "@agent-control-stack/shared";
import type { CodingMissionPorts } from "./controller.js";
import { codingMissionPortsFromEnv } from "./default-runtime.js";
import { runGovernedUnits, type GovernedDriverSummary } from "./governed-driver.js";
import { createGovernedExecution } from "./governed-runtime.js";
import { GovernedUnitRunner } from "./unit-runner.js";
import { CoderExecutionAdapter } from "./worker-execution.js";

const MAX_UNITS_CEILING = 10;

export interface GovernedWorkerConfig {
  workerId: string;
  /** Worker id to the actor its authority is issued to. A Map, so a worker id cannot resolve through Object.prototype. */
  actors: ReadonlyMap<string, string>;
  maxUnits: number;
}

function invalid(detail: string): ControlStackError {
  return new ControlStackError("governed_worker_config_invalid", `governed worker configuration is invalid: ${detail}`);
}

/**
 * `ACS_GOVERNED_WORKER_ACTORS` (a JSON object of worker id to actor id) switches governed unit execution on; unset means
 * off. Once it is set, a malformed value fails loudly: a typo must never leave governed work silently not running, or
 * running under an identity nobody chose. `ACS_GOVERNED_WORKER_ID` names this process's worker and must be a key of the
 * map. `ACS_GOVERNED_MAX_UNITS` caps units started per pass (1 to 10, default 1).
 */
export function readGovernedWorkerConfig(env: NodeJS.ProcessEnv): GovernedWorkerConfig | undefined {
  const rawActors = env.ACS_GOVERNED_WORKER_ACTORS;
  if (rawActors === undefined || rawActors.trim() === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawActors);
  } catch {
    throw invalid("ACS_GOVERNED_WORKER_ACTORS is not JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw invalid("ACS_GOVERNED_WORKER_ACTORS must be an object");
  }
  const actors = new Map<string, string>();
  for (const [worker, actor] of Object.entries(parsed)) {
    if (typeof actor !== "string" || actor.trim() === "" || worker.trim() === "") {
      throw invalid("every worker and actor id must be a non-empty string");
    }
    actors.set(worker, actor);
  }
  if (actors.size === 0) throw invalid("ACS_GOVERNED_WORKER_ACTORS names no workers");
  const workerId = env.ACS_GOVERNED_WORKER_ID?.trim();
  if (!workerId || !actors.has(workerId)) throw invalid("ACS_GOVERNED_WORKER_ID must be a key of the actor map");
  let maxUnits = 1;
  if (env.ACS_GOVERNED_MAX_UNITS !== undefined && env.ACS_GOVERNED_MAX_UNITS.trim() !== "") {
    maxUnits = Number(env.ACS_GOVERNED_MAX_UNITS);
    if (!Number.isInteger(maxUnits) || maxUnits < 1 || maxUnits > MAX_UNITS_CEILING) {
      throw invalid(`ACS_GOVERNED_MAX_UNITS must be an integer from 1 to ${MAX_UNITS_CEILING}`);
    }
  }
  return { workerId, actors, maxUnits };
}

/**
 * One governed pass for the worker process: when configured, run up to `maxUnits` ready coding units of governed
 * `general` missions through the coder lane. Returns undefined when governed execution is off or no coder executor is
 * configured. No operator is ever verified here, so this process cannot loosen a mission's policy. The database
 * connections are opened for the pass and always released.
 */
export async function resumeGovernedUnits(
  dbPath: string,
  env: NodeJS.ProcessEnv = process.env,
  dependencies: { ports?: Pick<CodingMissionPorts, "now" | "coder"> } = {}
): Promise<GovernedDriverSummary | undefined> {
  const config = readGovernedWorkerConfig(env);
  if (!config) return undefined;
  const ports = dependencies.ports ?? codingMissionPortsFromEnv(env, { dbPath });
  if (!ports) return undefined;
  const execution = createGovernedExecution({
    dbPath,
    verifyOperator: () => false,
    resolveActor: (workerId) => config.actors.get(workerId),
    clock: ports.now
  });
  try {
    const runner = new GovernedUnitRunner({
      execution,
      adapters: [new CoderExecutionAdapter(execution.missions, ports.coder, ports.now)],
      now: ports.now
    });
    return await runGovernedUnits(runner, execution.missions, {
      workerId: config.workerId,
      lane: "coder",
      unitKinds: ["coding"],
      maxUnits: config.maxUnits
    });
  } finally {
    execution.close();
  }
}
