import { existsSync, readFileSync } from "node:fs";
import { parseConfigText } from "@agent-control-stack/machine-controller";
import { z } from "zod";

const positiveInteger = z.number().int().positive();

const rawRuntimeConfigSchema = z
  .object({
    runtime: z
      .object({
        db_path: z.string().min(1).optional(),
        scheduler_interval_ms: positiveInteger.optional(),
        worker_interval_ms: positiveInteger.optional(),
        reconcile_interval_ms: positiveInteger.optional(),
        worker_id: z.string().min(1).optional(),
        status_port: z.coerce.number().int().min(1).max(65_535).optional()
      })
      .optional(),
    gateway: z
      .object({
        host: z.string().min(1).optional(),
        port: z.coerce.number().int().min(1).max(65_535).optional()
      })
      .optional()
  })
  .strict();

export interface RuntimeConfig {
  dbPath: string;
  gatewayHost: string;
  gatewayPort: number;
  schedulerIntervalMs: number;
  workerIntervalMs: number;
  reconcileIntervalMs: number;
  workerId: string;
  statusPort: number;
}

/**
 * Runtime settings are deliberately limited to process topology and timing.
 * Authentication, policy, approval, and execution authority remain in their
 * existing components and environment-backed configuration.
 */
export function loadRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const configPath = env.ACS_RUNTIME_CONFIG?.trim() || "acs.config.yaml";
  const parsed = existsSync(configPath)
    ? rawRuntimeConfigSchema.parse(parseConfigText(readFileSync(configPath, "utf8")))
    : {};
  const runtime = parsed.runtime ?? {};
  const gateway = parsed.gateway ?? {};
  return {
    dbPath: env.ACS_DB_PATH?.trim() || runtime.db_path || "storage/local.db",
    gatewayHost: env.HOST?.trim() || gateway.host || "127.0.0.1",
    gatewayPort: parsePort(env.PORT, gateway.port ?? 3000),
    schedulerIntervalMs: parseInterval(env.ACS_SCHEDULER_INTERVAL_MS, runtime.scheduler_interval_ms ?? 60_000),
    workerIntervalMs: parseInterval(env.ACS_WORKER_INTERVAL_MS, runtime.worker_interval_ms ?? 5_000),
    reconcileIntervalMs: parseInterval(env.ACS_RECONCILE_INTERVAL_MS, runtime.reconcile_interval_ms ?? 30_000),
    workerId: env.ACS_WORKER_ID?.trim() || runtime.worker_id || "local-runtime-worker",
    statusPort: parsePort(env.ACS_RUNTIME_STATUS_PORT, runtime.status_port ?? 3001)
  };
}

function parsePort(value: string | undefined, fallback: number): number {
  return z.coerce
    .number()
    .int()
    .min(1)
    .max(65_535)
    .parse(value ?? fallback);
}

function parseInterval(value: string | undefined, fallback: number): number {
  return positiveInteger.parse(value === undefined ? fallback : Number(value));
}
