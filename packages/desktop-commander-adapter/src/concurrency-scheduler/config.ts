import { ExecutionSchedulerError } from "./types.js";
import {
  DEFAULT_EXECUTION_SCHEDULER_CONFIG,
  type ExecutionSchedulerConfig
} from "./types.js";

export function desktopCommanderSchedulerConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env
): ExecutionSchedulerConfig {
  const defaults = DEFAULT_EXECUTION_SCHEDULER_CONFIG;
  return {
    maxQueued: positive(
      env.ACS_DESKTOP_COMMANDER_SCHEDULER_MAX_QUEUED,
      defaults.maxQueued,
      "ACS_DESKTOP_COMMANDER_SCHEDULER_MAX_QUEUED"
    ),
    maxQueuedPerAgent: positive(
      env.ACS_DESKTOP_COMMANDER_SCHEDULER_MAX_QUEUED_PER_AGENT,
      defaults.maxQueuedPerAgent,
      "ACS_DESKTOP_COMMANDER_SCHEDULER_MAX_QUEUED_PER_AGENT"
    ),
    maxQueuedPerSession: positive(
      env.ACS_DESKTOP_COMMANDER_SCHEDULER_MAX_QUEUED_PER_SESSION,
      defaults.maxQueuedPerSession,
      "ACS_DESKTOP_COMMANDER_SCHEDULER_MAX_QUEUED_PER_SESSION"
    ),
    maxOutstandingPerAgent: positive(
      env.ACS_DESKTOP_COMMANDER_SCHEDULER_MAX_OUTSTANDING_PER_AGENT,
      defaults.maxOutstandingPerAgent,
      "ACS_DESKTOP_COMMANDER_SCHEDULER_MAX_OUTSTANDING_PER_AGENT"
    ),
    maxActiveProcessesPerAgent: positive(
      env.ACS_DESKTOP_COMMANDER_SCHEDULER_MAX_ACTIVE_PROCESSES_PER_AGENT,
      defaults.maxActiveProcessesPerAgent,
      "ACS_DESKTOP_COMMANDER_SCHEDULER_MAX_ACTIVE_PROCESSES_PER_AGENT"
    ),
    maxMutationsPerRepoPerAgent: positive(
      env.ACS_DESKTOP_COMMANDER_SCHEDULER_MAX_MUTATIONS_PER_REPO_PER_AGENT,
      defaults.maxMutationsPerRepoPerAgent,
      "ACS_DESKTOP_COMMANDER_SCHEDULER_MAX_MUTATIONS_PER_REPO_PER_AGENT"
    ),
    queueTimeoutMs: positive(
      env.ACS_DESKTOP_COMMANDER_SCHEDULER_QUEUE_TIMEOUT_MS,
      defaults.queueTimeoutMs,
      "ACS_DESKTOP_COMMANDER_SCHEDULER_QUEUE_TIMEOUT_MS"
    ),
    lockTimeoutMs: positive(
      env.ACS_DESKTOP_COMMANDER_SCHEDULER_LOCK_TIMEOUT_MS,
      defaults.lockTimeoutMs,
      "ACS_DESKTOP_COMMANDER_SCHEDULER_LOCK_TIMEOUT_MS"
    ),
    retryAfterMs: positive(
      env.ACS_DESKTOP_COMMANDER_SCHEDULER_RETRY_AFTER_MS,
      defaults.retryAfterMs,
      "ACS_DESKTOP_COMMANDER_SCHEDULER_RETRY_AFTER_MS"
    ),
    laneLimits: {
      read: positive(
        env.ACS_DESKTOP_COMMANDER_SCHEDULER_READ_CONCURRENCY,
        defaults.laneLimits.read,
        "ACS_DESKTOP_COMMANDER_SCHEDULER_READ_CONCURRENCY"
      ),
      search: positive(
        env.ACS_DESKTOP_COMMANDER_SCHEDULER_SEARCH_CONCURRENCY,
        defaults.laneLimits.search,
        "ACS_DESKTOP_COMMANDER_SCHEDULER_SEARCH_CONCURRENCY"
      ),
      process: positive(
        env.ACS_DESKTOP_COMMANDER_SCHEDULER_PROCESS_CONCURRENCY,
        defaults.laneLimits.process,
        "ACS_DESKTOP_COMMANDER_SCHEDULER_PROCESS_CONCURRENCY"
      ),
      mutation: positive(
        env.ACS_DESKTOP_COMMANDER_SCHEDULER_MUTATION_CONCURRENCY,
        defaults.laneLimits.mutation,
        "ACS_DESKTOP_COMMANDER_SCHEDULER_MUTATION_CONCURRENCY"
      )
    }
  };
}

function positive(raw: string | undefined, fallback: number, label: string): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new ExecutionSchedulerError(
      "scheduler_config_invalid",
      `${label} must be a positive integer`
    );
  }
  return value;
}
