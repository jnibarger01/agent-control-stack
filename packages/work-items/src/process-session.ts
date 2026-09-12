import { z } from "zod";

/**
 * ADR 0016 Slice 4 - Desktop Commander process-session persistence.
 *
 * Nothing before this module binds a spawned OS process (a `start_process`
 * pid) to the work item / caller that started it, so a read-only tool like
 * `read_process_output(pid)` has zero ownership check today: any caller who
 * can claim work can read the output of ANY pid on the host, including one
 * ACS never started. This module is the missing binding.
 *
 * `pid` alone is never a safe identity - the OS reuses pids across unrelated
 * processes over time. The full identity a session claims ownership over is
 * the triple `(pid, bootId, procStartTicks)`; a caller wanting to act on a
 * pid must present the same triple recorded when the session was created,
 * and `verifyProcessSessionOwnership` fails closed (denies) on any mismatch,
 * a missing session, or a session that is not `active`.
 */

const identifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const timestampSchema = z.string().datetime({ offset: true }).max(64);
const bootIdSchema = z.string().min(1).max(256);
const pidSchema = z.number().int().min(1).max(2_147_483_647);
const procStartTicksSchema = z.number().int().nonnegative();

export const processSessionStatusSchema = z.enum(["active", "closed", "lost", "reconciling"]);
export type ProcessSessionStatus = z.infer<typeof processSessionStatusSchema>;

export const processSessionSchema = z
  .object({
    id: identifierSchema,
    workItemId: identifierSchema,
    actionHash: hashSchema,
    workerId: identifierSchema,
    pid: pidSchema,
    bootId: bootIdSchema,
    procStartTicks: procStartTicksSchema,
    dcSessionId: z.string().min(1).max(256).optional(),
    status: processSessionStatusSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    lastSeenAt: timestampSchema.optional(),
    closedAt: timestampSchema.optional()
  })
  .strict();

export type ProcessSession = z.infer<typeof processSessionSchema>;

export const createProcessSessionInputSchema = z
  .object({
    workItemId: identifierSchema,
    actionHash: hashSchema,
    workerId: identifierSchema,
    pid: pidSchema,
    bootId: bootIdSchema,
    procStartTicks: procStartTicksSchema,
    dcSessionId: z.string().min(1).max(256).optional(),
    now: z.date().optional()
  })
  .strict();

export type CreateProcessSessionInput = z.infer<typeof createProcessSessionInputSchema>;

/**
 * Everything a caller must present to prove it owns the process it wants a
 * DC tool (e.g. `read_process_output`) to act on. `workItemId` binds
 * ownership to the work item that started the process, not merely to
 * "whichever worker is calling right now" - a worker that lost its lease and
 * a new worker claiming the same work item legitimately share ownership,
 * but an unrelated work item never does.
 */
export const verifyProcessSessionOwnershipInputSchema = z
  .object({
    workItemId: identifierSchema,
    pid: pidSchema,
    bootId: bootIdSchema,
    procStartTicks: procStartTicksSchema
  })
  .strict();

export type VerifyProcessSessionOwnershipInput = z.infer<typeof verifyProcessSessionOwnershipInputSchema>;

export interface ProcessSessionRow {
  id: string;
  work_item_id: string;
  action_hash: string;
  worker_id: string;
  pid: number;
  boot_id: string;
  proc_start_ticks: number;
  dc_session_id: string | null;
  status: ProcessSessionStatus;
  created_at: string;
  updated_at: string;
  last_seen_at: string | null;
  closed_at: string | null;
}

export function rowToProcessSession(row: ProcessSessionRow): ProcessSession {
  return processSessionSchema.parse({
    id: row.id,
    workItemId: row.work_item_id,
    actionHash: row.action_hash,
    workerId: row.worker_id,
    pid: row.pid,
    bootId: row.boot_id,
    procStartTicks: row.proc_start_ticks,
    ...(row.dc_session_id ? { dcSessionId: row.dc_session_id } : {}),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.last_seen_at ? { lastSeenAt: row.last_seen_at } : {}),
    ...(row.closed_at ? { closedAt: row.closed_at } : {})
  });
}
