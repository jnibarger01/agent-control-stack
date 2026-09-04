import { ControlStackError } from "@agent-control-stack/shared";

/**
 * Execution backend selection.
 *
 * `dry_run` (the default) is the simulation path that has always shipped.
 * `desktop_commander` routes an authorized attempt to the local Desktop
 * Commander MCP through the ACS execution-authorization boundary.
 * `native_engine` routes a persisted native mission through the exact
 * registry adapter selected by the closed route table and EngineIsolation.
 *
 * Selection is explicit configuration only (`ACS_EXECUTION_BACKEND`). An
 * unknown value fails closed rather than falling back to a permissive mode.
 */
export const EXECUTION_BACKENDS = ["dry_run", "desktop_commander", "native_engine"] as const;
export type ExecutionBackend = (typeof EXECUTION_BACKENDS)[number];
export const DEFAULT_EXECUTION_BACKEND: ExecutionBackend = "dry_run";

export function resolveExecutionBackend(env: NodeJS.ProcessEnv = process.env): ExecutionBackend {
  const raw = env.ACS_EXECUTION_BACKEND?.trim();
  if (raw === undefined || raw === "" || raw === "dry_run") {
    return "dry_run";
  }
  if (raw === "desktop_commander") {
    return "desktop_commander";
  }
  if (raw === "native_engine") {
    return "native_engine";
  }
  throw new ControlStackError(
    "execution_backend_invalid",
    `unknown ACS_EXECUTION_BACKEND: ${raw} (expected one of ${EXECUTION_BACKENDS.join(", ")})`
  );
}

export function isExecutionBackend(value: unknown): value is ExecutionBackend {
  return typeof value === "string" && (EXECUTION_BACKENDS as readonly string[]).includes(value);
}
