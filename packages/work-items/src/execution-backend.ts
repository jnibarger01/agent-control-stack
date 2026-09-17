import { ControlStackError } from "@agent-control-stack/shared";

/**
 * Execution backend selection.
 *
 * `dry_run` (the default) is the simulation path that has always shipped.
 * `desktop_commander` routes an authorized attempt to the local Desktop
 * Commander MCP through the ACS execution-authorization boundary.
 *
 * Selection is explicit configuration only (`ACS_EXECUTION_BACKEND`). An
 * unknown value fails closed rather than falling back to a permissive mode.
 */
export const EXECUTION_BACKENDS = ["dry_run", "desktop_commander"] as const;
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
  throw new ControlStackError(
    "execution_backend_invalid",
    `unknown ACS_EXECUTION_BACKEND: ${raw} (expected one of ${EXECUTION_BACKENDS.join(", ")})`
  );
}

export function isExecutionBackend(value: unknown): value is ExecutionBackend {
  return typeof value === "string" && (EXECUTION_BACKENDS as readonly string[]).includes(value);
}
