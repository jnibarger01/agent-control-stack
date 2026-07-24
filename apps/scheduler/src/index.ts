import { readFileSync } from "node:fs";
import { createPolicyEngine, createWorkItemTools } from "@agent-control-stack/policy-gate";
import { stableHash } from "@agent-control-stack/shared";
import { SqliteWorkItemStore, type WorkItem, type WorkItemStore } from "@agent-control-stack/work-items";
import { z } from "zod";

/**
 * apps/scheduler is a thin, boring client of packages/policy-gate's create_work_item tool.
 *
 * It intentionally does not:
 *  - write to the work-item store directly (SqliteWorkItemStore.create is never called here;
 *    only createWorkItemTools().create_work_item is);
 *  - grant itself elevated privilege or skip policy evaluation;
 *  - run as a long-running daemon (see docs/adr/0013-systemd-timer-worker-invocation.md, whose
 *    "thin CLI binary invoked by systemd timer" shape this mirrors for scheduled job intake).
 *
 * Schedules are a static, human-authored config: an array of { scheduleId, intervalMs,
 * workItemTemplate } entries. There is no cron-expression parser here on purpose -- fire times
 * are computed from a fixed interval grid anchored at `anchor` (default: the Unix epoch), which
 * gives a deterministic "next fire time given last fire time and interval" model without needing
 * to persist explicit scheduler state: the most recent grid point at or before `now` *is* the
 * last fire time, and the next one is always exactly `intervalMs` after it.
 */

const identifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u, "must start with an alphanumeric and contain only [A-Za-z0-9._:-]");

const scheduleTargetSchema = z
  .object({
    repo: z.string().min(1).optional(),
    cwd: z.string().min(1).optional(),
    files: z.array(z.string().min(1)).optional(),
    services: z.array(z.string().min(1)).optional()
  })
  .strict()
  .default({});

const scheduleActionSchema = z
  .object({
    kind: z.string().min(1),
    description: z.string().min(1),
    params: z.record(z.string(), z.unknown()).default({})
  })
  .strict();

export const scheduleWorkItemTemplateSchema = z
  .object({
    title: z.string().min(1).max(200),
    requester: z.enum(["user", "agent", "system"]),
    intent: z.string().min(1).max(4_000),
    target: scheduleTargetSchema,
    requestedActions: z.array(scheduleActionSchema).min(1).max(32),
    risk: z.enum(["low", "medium", "high", "critical"])
  })
  .strict();

export const scheduleEntrySchema = z
  .object({
    scheduleId: identifierSchema,
    /** Fixed firing interval in milliseconds. No cron syntax -- see module doc comment. */
    intervalMs: z
      .number()
      .int()
      .positive()
      .max(30 * 24 * 60 * 60 * 1_000),
    /** Grid anchor for fire-time alignment. Defaults to the Unix epoch when omitted. */
    anchor: z.string().datetime({ offset: true }).optional(),
    workItemTemplate: scheduleWorkItemTemplateSchema
  })
  .strict();

export const scheduleConfigSchema = z.array(scheduleEntrySchema);

export type ScheduleWorkItemTemplate = z.infer<typeof scheduleWorkItemTemplateSchema>;
export type ScheduleEntry = z.infer<typeof scheduleEntrySchema>;
export type ScheduleConfig = z.infer<typeof scheduleConfigSchema>;

export interface SchedulerOptions {
  dbPath?: string;
  /** Pre-validated schedule config. Takes precedence over scheduleConfigPath / env var. */
  schedules?: ScheduleConfig;
  /** Path to a JSON file holding a ScheduleConfig, validated with scheduleConfigSchema. */
  scheduleConfigPath?: string;
  now?: Date;
}

export interface SchedulerFiring {
  scheduleId: string;
  scheduledFiringTime: string;
  idempotencyKey: string;
  created: boolean;
  workItemId?: string;
}

export interface SchedulerResult {
  firings: SchedulerFiring[];
}

const IDEMPOTENCY_MARKER_DOMAIN = "acs-scheduler-firing";

/**
 * Deterministic idempotency key for a single scheduled firing, derived from
 * (scheduleId, scheduledFiringTime) only -- matches the pattern used by
 * apps/worker's workerResultIdempotencyKey (stableHash over a fixed domain + identifying fields).
 */
export function scheduledFiringIdempotencyKey(scheduleId: string, scheduledFiringTime: Date): string {
  return stableHash({
    domain: "acs.scheduler-firing",
    scheduleId,
    scheduledFiringTime: scheduledFiringTime.toISOString()
  });
}

/**
 * The most recent grid-aligned fire time at or before `now`, or undefined if the schedule's
 * anchor is still in the future. Calling this twice with two `now` values inside the same
 * interval bucket returns the same instant, which is what makes duplicate scheduler invocations
 * (crash-restart, overlapping timers) resolve to the same idempotency key.
 */
export function mostRecentScheduledFiring(schedule: ScheduleEntry, now: Date): Date | undefined {
  const anchorMs = schedule.anchor ? Date.parse(schedule.anchor) : 0;
  const elapsedMs = now.getTime() - anchorMs;
  if (elapsedMs < 0) {
    return undefined;
  }
  const ticks = Math.floor(elapsedMs / schedule.intervalMs);
  return new Date(anchorMs + ticks * schedule.intervalMs);
}

export function loadScheduleConfig(path: string): ScheduleConfig {
  const raw = readFileSync(path, "utf8");
  return scheduleConfigSchema.parse(JSON.parse(raw));
}

function idempotencyMarker(idempotencyKey: string): string {
  return `[${IDEMPOTENCY_MARKER_DOMAIN}:${idempotencyKey}]`;
}

/**
 * The work-item store has no dedicated scheduler-idempotency column, so the marker is embedded
 * in the title (the same "reuse an existing field" approach documented as acceptable for this
 * phase) and checked via store.list() before create_work_item is called. This is intentionally
 * simple rather than clever: correctness (never double-create for one firing) matters more than
 * lookup efficiency here.
 */
function findExistingFiring(store: WorkItemStore, idempotencyKey: string): WorkItem | undefined {
  const marker = idempotencyMarker(idempotencyKey);
  return store.list().find((item) => item.title.includes(marker));
}

function resolveScheduleConfig(options: SchedulerOptions): ScheduleConfig {
  if (options.schedules !== undefined) {
    return scheduleConfigSchema.parse(options.schedules);
  }
  const path = options.scheduleConfigPath ?? process.env.ACS_SCHEDULE_CONFIG_PATH;
  if (!path) {
    return [];
  }
  return loadScheduleConfig(path);
}

export async function runSchedulerOnce(options: SchedulerOptions = {}): Promise<SchedulerResult> {
  const dbPath = options.dbPath ?? process.env.ACS_DB_PATH ?? "storage/local.db";
  const now = options.now ?? new Date();
  const schedules = resolveScheduleConfig(options);

  const store = new SqliteWorkItemStore(dbPath);
  // The scheduler is a thin client of the sanctioned create_work_item tool -- it never calls
  // store.create() directly and never grants itself elevated privilege.
  const tools = createWorkItemTools(store, createPolicyEngine());

  try {
    const firings: SchedulerFiring[] = [];

    for (const schedule of schedules) {
      const scheduledFiringTime = mostRecentScheduledFiring(schedule, now);
      if (!scheduledFiringTime) {
        continue;
      }

      const idempotencyKey = scheduledFiringIdempotencyKey(schedule.scheduleId, scheduledFiringTime);
      const existing = findExistingFiring(store, idempotencyKey);
      if (existing) {
        firings.push({
          scheduleId: schedule.scheduleId,
          scheduledFiringTime: scheduledFiringTime.toISOString(),
          idempotencyKey,
          created: false,
          workItemId: existing.id
        });
        continue;
      }

      const template = schedule.workItemTemplate;
      const workItem = tools.create_work_item({
        title: `${template.title} ${idempotencyMarker(idempotencyKey)}`,
        requester: template.requester,
        intent: template.intent,
        target: template.target,
        requestedActions: template.requestedActions,
        risk: template.risk
      });

      firings.push({
        scheduleId: schedule.scheduleId,
        scheduledFiringTime: scheduledFiringTime.toISOString(),
        idempotencyKey,
        created: true,
        workItemId: workItem.id
      });
    }

    return { firings };
  } finally {
    store.close();
  }
}
