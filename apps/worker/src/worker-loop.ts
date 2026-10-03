import { ControlStackError } from "@agent-control-stack/shared";
import type { WorkerOptions, WorkerResult } from "./index.js";
import { runWorkerOnce } from "./index.js";

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const MAX_RETRY_BACKOFF_MS = 60_000;

export interface WorkerLoopOptions {
  workerOptions: WorkerOptions;
  pollIntervalMs: number;
  signal: AbortSignal;
  runOnce?: (options: WorkerOptions) => Promise<WorkerResult>;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  onResult?: (result: WorkerResult) => void;
  onTransientFailure?: (code: string, retryInMs: number) => void;
}

export function workerPollIntervalMsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ACS_WORKER_POLL_INTERVAL_MS;
  const value = raw === undefined ? DEFAULT_POLL_INTERVAL_MS : Number(raw);
  if (!Number.isInteger(value) || value < 250 || value > MAX_RETRY_BACKOFF_MS) {
    throw new ControlStackError(
      "worker_poll_interval_invalid",
      "ACS_WORKER_POLL_INTERVAL_MS must be between 250 and 60000"
    );
  }
  return value;
}

export async function runWorkerLoop(options: WorkerLoopOptions): Promise<void> {
  const runOnce = options.runOnce ?? runWorkerOnce;
  const wait = options.wait ?? waitForInterval;
  let consecutiveClaimFailures = 0;

  while (!options.signal.aborted) {
    let result: WorkerResult;
    try {
      result = await runOnce(options.workerOptions);
    } catch (error) {
      if (!(error instanceof ControlStackError) || error.code !== "worker_claim_unavailable") throw error;
      consecutiveClaimFailures += 1;
      const retryInMs = Math.min(
        options.pollIntervalMs * 2 ** Math.min(consecutiveClaimFailures - 1, 16),
        MAX_RETRY_BACKOFF_MS
      );
      options.onTransientFailure?.(error.code, retryInMs);
      await wait(retryInMs, options.signal);
      continue;
    }

    consecutiveClaimFailures = 0;
    options.onResult?.(result);
    if (!result.executed) await wait(options.pollIntervalMs, options.signal);
  }
}

function waitForInterval(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
  });
}
