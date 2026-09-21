import type { FastifyInstance } from "fastify";
import { ControlStackError } from "@agent-control-stack/shared";

export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;
export const DEFAULT_DRAIN_TIMEOUT_MS = 8_000;
export const DEFAULT_DRAIN_POLL_MS = 50;
export const SHUTDOWN_DRAIN_METRIC = "acs_shutdown_drain_total";
export const GATEWAY_SHUTTING_DOWN_CODE = "gateway_shutting_down";

export interface GatewayProcess {
  once(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  exit(code?: number): never;
  exitCode?: string | number | null;
}

/** Shared flag that claim/MCP mutating intake checks during graceful shutdown. */
export class ShutdownController {
  private shuttingDown = false;

  isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  /** Returns true the first time shutdown begins; false if already shutting down. */
  beginShutdown(): boolean {
    if (this.shuttingDown) return false;
    this.shuttingDown = true;
    return true;
  }

  assertAcceptingClaims(): void {
    if (this.shuttingDown) {
      throw new ControlStackError(GATEWAY_SHUTTING_DOWN_CODE, "gateway is shutting down; new claims are not accepted");
    }
  }

  assertAcceptingMutatingIntake(): void {
    if (this.shuttingDown) {
      throw new ControlStackError(
        GATEWAY_SHUTTING_DOWN_CODE,
        "gateway is shutting down; mutating intake is not accepted"
      );
    }
  }
}

export interface DrainStartInfo {
  signal: "SIGINT" | "SIGTERM";
  activeLeases: number;
  drainTimeoutMs: number;
}

export interface DrainFinishInfo {
  signal: "SIGINT" | "SIGTERM";
  activeLeases: number;
  timedOut: boolean;
  waitedMs: number;
}

export interface GracefulShutdownOptions {
  runtime?: GatewayProcess;
  /** Hard force-exit timeout covering drain + close. */
  timeoutMs?: number;
  /** Max time to wait for active leases before app.close(). */
  drainTimeoutMs?: number;
  drainPollMs?: number;
  shutdownController?: ShutdownController;
  countActiveLeases?: () => number;
  /** Sweep expired leases while draining so the waiter can finish early. */
  failExpiredLeases?: () => void;
  onDrainStart?: (info: DrainStartInfo) => void;
  onDrainFinish?: (info: DrainFinishInfo) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

type LegacyRuntime = GatewayProcess;

function isGatewayProcess(value: unknown): value is GatewayProcess {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as GatewayProcess).once === "function" &&
    typeof (value as GatewayProcess).exit === "function"
  );
}

function resolveOptions(
  runtimeOrOptions: GracefulShutdownOptions | LegacyRuntime | undefined,
  timeoutMsLegacy: number | undefined
): Required<Pick<GracefulShutdownOptions, "runtime" | "timeoutMs" | "drainTimeoutMs" | "drainPollMs">> &
  GracefulShutdownOptions {
  if (isGatewayProcess(runtimeOrOptions)) {
    const timeoutMs = timeoutMsLegacy ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    return {
      runtime: runtimeOrOptions,
      timeoutMs,
      drainTimeoutMs: Math.min(DEFAULT_DRAIN_TIMEOUT_MS, Math.max(0, timeoutMs - 1_000)),
      drainPollMs: DEFAULT_DRAIN_POLL_MS
    };
  }
  const options = runtimeOrOptions ?? {};
  const timeoutMs = options.timeoutMs ?? timeoutMsLegacy ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  const drainTimeoutMs = options.drainTimeoutMs ?? Math.min(DEFAULT_DRAIN_TIMEOUT_MS, Math.max(0, timeoutMs - 1_000));
  return {
    ...options,
    runtime: options.runtime ?? process,
    timeoutMs,
    drainTimeoutMs,
    drainPollMs: options.drainPollMs ?? DEFAULT_DRAIN_POLL_MS
  };
}

async function defaultSleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait until active leases drain to zero or drainTimeoutMs elapses.
 * Periodically fails expired leases so a natural expiry can unblock the waiter.
 */
export async function waitForLeaseDrain(input: {
  drainTimeoutMs: number;
  drainPollMs: number;
  countActiveLeases: () => number;
  failExpiredLeases?: () => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<{ timedOut: boolean; waitedMs: number; activeLeases: number }> {
  const sleep = input.sleep ?? defaultSleep;
  const now = input.now ?? Date.now;
  const started = now();
  const deadline = started + input.drainTimeoutMs;

  while (true) {
    try {
      input.failExpiredLeases?.();
    } catch {
      // Expiry sweep is best-effort during drain; close still proceeds on timeout.
    }
    const activeLeases = Math.max(0, input.countActiveLeases());
    const waitedMs = Math.max(0, now() - started);
    if (activeLeases === 0) {
      return { timedOut: false, waitedMs, activeLeases: 0 };
    }
    if (now() >= deadline) {
      return { timedOut: true, waitedMs, activeLeases };
    }
    const remaining = Math.max(0, deadline - now());
    await sleep(Math.min(input.drainPollMs, remaining || input.drainPollMs));
  }
}

/**
 * Install SIGINT/SIGTERM handlers that:
 * 1. Flip shutting_down (reject new claims / optional MCP mutating intake)
 * 2. Wait up to drainTimeoutMs for active leases to complete or expire
 * 3. Call app.close(), with a hard timeoutMs force-exit so stuck work cannot hang forever
 */

/** Wrap claim tools so they refuse new claims once shutting_down is set. Renew/submit stay untouched. */
export function guardWorkItemClaimTools<
  T extends {
    claim_next_approved_work_item: (input: unknown) => unknown;
    claim_approved_work_item_by_id: (input: unknown) => unknown;
  }
>(tools: T, controller: ShutdownController): T {
  return {
    ...tools,
    claim_next_approved_work_item(input: unknown) {
      controller.assertAcceptingClaims();
      return tools.claim_next_approved_work_item(input);
    },
    claim_approved_work_item_by_id(input: unknown) {
      controller.assertAcceptingClaims();
      return tools.claim_approved_work_item_by_id(input);
    }
  };
}

export function installGracefulShutdown(
  app: Pick<FastifyInstance, "close" | "log">,
  runtimeOrOptions: GracefulShutdownOptions | LegacyRuntime = process,
  timeoutMsLegacy?: number
): ShutdownController {
  const options = resolveOptions(runtimeOrOptions, timeoutMsLegacy);
  const runtime = options.runtime!;
  const timeoutMs = options.timeoutMs!;
  const drainTimeoutMs = options.drainTimeoutMs!;
  const drainPollMs = options.drainPollMs!;
  const controller = options.shutdownController ?? new ShutdownController();
  const countActiveLeases = options.countActiveLeases ?? (() => 0);
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;

  const shutdown = (signal: "SIGINT" | "SIGTERM") => {
    if (!controller.beginShutdown()) return;

    app.log.info({ signal, drainTimeoutMs, timeoutMs }, "gateway shutdown started");
    const activeAtStart = Math.max(0, countActiveLeases());
    options.onDrainStart?.({ signal, activeLeases: activeAtStart, drainTimeoutMs });

    const timeout = setTimeout(() => {
      app.log.error({ signal, timeoutMs }, "gateway shutdown timed out");
      runtime.exit(1);
    }, timeoutMs);
    timeout.unref();

    void (async () => {
      try {
        const drain = await waitForLeaseDrain({
          drainTimeoutMs,
          drainPollMs,
          countActiveLeases,
          failExpiredLeases: options.failExpiredLeases,
          sleep,
          now
        });
        options.onDrainFinish?.({
          signal,
          activeLeases: drain.activeLeases,
          timedOut: drain.timedOut,
          waitedMs: drain.waitedMs
        });
        if (drain.timedOut) {
          app.log.warn(
            { signal, activeLeases: drain.activeLeases, drainTimeoutMs, waitedMs: drain.waitedMs },
            "gateway shutdown drain timed out; force-closing"
          );
        } else {
          app.log.info({ signal, waitedMs: drain.waitedMs }, "gateway shutdown drain complete");
        }

        await app.close();
        clearTimeout(timeout);
        runtime.exitCode = 0;
        app.log.info({ signal }, "gateway shutdown complete");
      } catch (error: unknown) {
        clearTimeout(timeout);
        app.log.error({ error, signal }, "gateway shutdown failed");
        runtime.exitCode = 1;
      }
    })();
  };

  runtime.once("SIGINT", () => shutdown("SIGINT"));
  runtime.once("SIGTERM", () => shutdown("SIGTERM"));
  return controller;
}

export function resolveDrainTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
  fallback = DEFAULT_DRAIN_TIMEOUT_MS
): number {
  const raw = env.ACS_GATEWAY_DRAIN_TIMEOUT_MS?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}

export function resolveShutdownTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
  fallback = DEFAULT_SHUTDOWN_TIMEOUT_MS
): number {
  const raw = env.ACS_GATEWAY_SHUTDOWN_TIMEOUT_MS?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

export interface GatewayShutdownHooks {
  controller: ShutdownController;
  countActiveLeases: () => number;
  failExpiredLeases: () => void;
  recordDrainStart: (details: DrainStartInfo) => void;
  recordDrainFinish: (details: DrainFinishInfo) => void;
}

declare module "fastify" {
  interface FastifyInstance {
    acsShutdown?: GatewayShutdownHooks;
  }
}
