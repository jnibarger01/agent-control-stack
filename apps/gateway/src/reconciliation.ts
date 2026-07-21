import type { SqliteWorkItemStore } from "@agent-control-stack/work-items";

export interface ReconciliationHealth {
  ok: boolean;
  code?: string;
  lastRunAt?: string;
  ageMs?: number;
}

export interface ReconciliationOptions {
  intervalMs?: number;
  onError?: (error: unknown) => void;
}

const DEFAULT_RECONCILIATION_INTERVAL_MS = 60_000;

export class GatewayReconciler {
  private readonly intervalMs: number;
  private readonly onError: (error: unknown) => void;
  private timer: NodeJS.Timeout | undefined;
  private lastRunAt: Date | undefined;
  private lastError: string | undefined;

  constructor(
    private readonly store: SqliteWorkItemStore,
    options: ReconciliationOptions = {}
  ) {
    this.intervalMs = normalizeInterval(options.intervalMs);
    this.onError = options.onError ?? (() => undefined);
  }

  async runOnce(): Promise<void> {
    try {
      this.store.reconcileStaleTunnelSessions();
      this.store.reconcileStaleAgents();
      this.lastRunAt = new Date();
      this.lastError = undefined;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.onError(error);
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.runOnce();
    }, this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  health(now = new Date()): ReconciliationHealth {
    if (this.lastError) {
      return {
        ok: false,
        code: "reconciliation_failed",
        ...(this.lastRunAt ? { lastRunAt: this.lastRunAt.toISOString() } : {})
      };
    }
    if (!this.lastRunAt) {
      return { ok: false, code: "reconciliation_not_run" };
    }
    const ageMs = now.getTime() - this.lastRunAt.getTime();
    if (ageMs > this.intervalMs * 2) {
      return { ok: false, code: "reconciliation_stale", lastRunAt: this.lastRunAt.toISOString(), ageMs };
    }
    return { ok: true, lastRunAt: this.lastRunAt.toISOString(), ageMs };
  }
}

function normalizeInterval(value: number | undefined): number {
  if (value === undefined) return DEFAULT_RECONCILIATION_INTERVAL_MS;
  if (!Number.isInteger(value) || value < 1_000 || value > 24 * 60 * 60 * 1_000) {
    throw new Error("reconciliation interval must be an integer between 1000ms and 86400000ms");
  }
  return value;
}
