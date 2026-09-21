import {
  checkSandboxPrerequisites,
  type SandboxPrerequisiteCheck,
  type SandboxPrerequisiteOptions
} from "@agent-control-stack/sandbox";

/** Env gate for optional /readyz sandbox backend checks. Default: off (dry-run alpha). */
export const SANDBOX_READYZ_PROBE_ENV = "ACS_READYZ_SANDBOX_PROBE";

export type GatewayHealthCheck = { ok: true } | { ok: false; code: string };

export interface SandboxReadinessOptions {
  /** When true, /readyz includes the sandbox prerequisites check. */
  enabled?: boolean;
  /** Override probe paths / platform (tests and atypical installs). */
  prerequisites?: SandboxPrerequisiteOptions;
  /** Inject a check result (tests). */
  check?: () => SandboxPrerequisiteCheck;
}

export function isSandboxReadyzProbeEnabled(
  env: NodeJS.ProcessEnv = process.env,
  options?: SandboxReadinessOptions
): boolean {
  if (options?.enabled !== undefined) {
    return options.enabled;
  }
  return env[SANDBOX_READYZ_PROBE_ENV] === "1";
}

/**
 * Run the optional sandbox host prerequisite probe.
 * Returns undefined when the probe is disabled so callers leave /readyz unchanged.
 */
export function evaluateSandboxReadyzCheck(
  options: SandboxReadinessOptions = {},
  env: NodeJS.ProcessEnv = process.env
): GatewayHealthCheck | undefined {
  if (!isSandboxReadyzProbeEnabled(env, options)) {
    return undefined;
  }
  if (options.check) {
    return options.check();
  }
  return checkSandboxPrerequisites(options.prerequisites ?? {});
}

export function mergeSandboxReadyzCheck<T extends { ok: boolean; checks: Record<string, GatewayHealthCheck> }>(
  health: T,
  sandboxCheck: GatewayHealthCheck | undefined
): T & { ok: boolean; checks: T["checks"] & { sandbox?: GatewayHealthCheck } } {
  if (!sandboxCheck) {
    return health;
  }
  const checks = { ...health.checks, sandbox: sandboxCheck };
  return {
    ...health,
    ok: health.ok && sandboxCheck.ok,
    checks
  };
}
