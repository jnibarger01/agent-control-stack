import { createHash, randomBytes, randomUUID } from "node:crypto";
import postgres, { type Sql } from "postgres";
import { createPolicyEngine } from "@agent-control-stack/policy-gate";
import { stableHash } from "@agent-control-stack/shared";
import {
  actionRequestSchema,
  createWorkItemSchema,
  submitWorkResultSchema,
  targetSchema,
  workItemRiskSchema,
  workItemSchema,
  workItemStatusSchema,
  type WorkItem
} from "@agent-control-stack/work-items";
import { z } from "zod";
import type { HostedGatewayConfig } from "./config.js";

export const hostedCreateWorkItemSchema = z
  .object({
    title: z.string().min(1).max(512),
    intent: z.string().min(1).max(4_000),
    target: targetSchema.optional(),
    requestedActions: z.array(actionRequestSchema).min(1).max(32),
    risk: workItemRiskSchema.optional(),
    metadata: createWorkItemSchema.shape.metadata.optional()
  })
  .strict();

export const hostedListWorkItemsSchema = z
  .object({ status: workItemStatusSchema.optional(), limit: z.number().int().positive().max(200).default(50) })
  .strict();

export const hostedApprovalSchema = z
  .object({ actionHash: z.string().regex(/^[a-f0-9]{64}$/iu), reason: z.string().min(1).max(2_000) })
  .strict();

export const hostedReasonSchema = z.object({ reason: z.string().min(1).max(2_000).optional() }).strict();

export const hostedClaimSchema = z.object({ leaseMs: z.number().int().positive().optional() }).strict();

export type HostedWorkItem = WorkItem & {
  readonly policy?: HostedPolicyReceipt;
};

export interface HostedPolicyReceipt {
  readonly decision: string;
  readonly reason: string;
  readonly evaluations: Array<{ actionHash: string; decision: string; reason: string }>;
}

export interface HostedClaim {
  readonly workItem: WorkItem;
  readonly leaseId: string;
  readonly leaseToken: string;
  readonly workerId: string;
  readonly actionHash: string;
  readonly planHash: string;
  readonly leaseExpiresAt: string;
}

interface StoredWorkItemRow extends Record<string, unknown> {
  id: string;
  title: string;
  requester: string;
  requester_subject: string | null;
  status: string;
  intent: string;
  target_json: unknown;
  actions_json: unknown;
  risk: string;
  metadata_json: unknown | null;
  policy_json: unknown | null;
  result_json: unknown | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export class HostedPostgresStore {
  private readonly sql: Sql;
  private readonly policy = createPolicyEngine();

  constructor(private readonly config: HostedGatewayConfig) {
    this.sql = postgres(config.databaseUrl, {
      max: 1,
      idle_timeout: 20,
      connect_timeout: 10,
      prepare: false
    });
  }

  async migrate(): Promise<void> {
    await this.sql`
      CREATE TABLE IF NOT EXISTS acs_hosted_work_items (
        id text PRIMARY KEY,
        title text NOT NULL,
        requester text NOT NULL,
        requester_subject text,
        status text NOT NULL,
        intent text NOT NULL,
        target_json jsonb NOT NULL,
        actions_json jsonb NOT NULL,
        risk text NOT NULL,
        metadata_json jsonb,
        policy_json jsonb,
        result_json jsonb,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      )
    `;
    await this.sql`CREATE INDEX IF NOT EXISTS acs_hosted_work_items_status_created_idx ON acs_hosted_work_items(status, created_at)`;
    await this.sql`
      CREATE TABLE IF NOT EXISTS acs_hosted_approvals (
        id text PRIMARY KEY,
        work_item_id text NOT NULL REFERENCES acs_hosted_work_items(id),
        action_hash text NOT NULL,
        approved_by text NOT NULL,
        reason text NOT NULL,
        created_at timestamptz NOT NULL,
        UNIQUE(work_item_id, action_hash)
      )
    `;
    await this.sql`
      CREATE TABLE IF NOT EXISTS acs_hosted_leases (
        id text PRIMARY KEY,
        work_item_id text NOT NULL REFERENCES acs_hosted_work_items(id),
        worker_id text NOT NULL,
        lease_token_hash text NOT NULL,
        action_hash text NOT NULL,
        plan_hash text NOT NULL,
        expires_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL,
        completed_at timestamptz
      )
    `;
    await this.sql`CREATE INDEX IF NOT EXISTS acs_hosted_leases_active_idx ON acs_hosted_leases(expires_at) WHERE completed_at IS NULL`;
    await this.sql`
      CREATE TABLE IF NOT EXISTS acs_hosted_result_idempotency (
        idempotency_key text PRIMARY KEY,
        work_item_id text NOT NULL REFERENCES acs_hosted_work_items(id),
        result_json jsonb NOT NULL,
        created_at timestamptz NOT NULL
      )
    `;
    await this.sql`
      CREATE TABLE IF NOT EXISTS acs_hosted_audit_head (
        singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
        sequence bigint NOT NULL,
        event_hash text NOT NULL
      )
    `;
    await this.sql`
      INSERT INTO acs_hosted_audit_head(singleton, sequence, event_hash)
      VALUES (true, 0, '') ON CONFLICT (singleton) DO NOTHING
    `;
    await this.sql`
      CREATE TABLE IF NOT EXISTS acs_hosted_audit_events (
        sequence bigint PRIMARY KEY,
        event_id text UNIQUE NOT NULL,
        event_type text NOT NULL,
        actor text NOT NULL,
        work_item_id text,
        payload_json jsonb NOT NULL,
        previous_hash text NOT NULL,
        event_hash text NOT NULL,
        created_at timestamptz NOT NULL
      )
    `;
  }

  async health(): Promise<{ ok: boolean; auditSequence: number }> {
    const rows = await this.sql<{ sequence: string | number }[]>`
      SELECT sequence FROM acs_hosted_audit_head WHERE singleton = true
    `;
    return { ok: rows.length === 1, auditSequence: Number(rows[0]?.sequence ?? 0) };
  }

  async create(input: unknown, subject: string): Promise<WorkItem> {
    const parsed = hostedCreateWorkItemSchema.parse(input);
    const now = new Date().toISOString();
    const initial = workItemSchema.parse({
      ...parsed,
      requester: "agent",
      requesterSubject: subject,
      status: "pending_policy",
      target: parsed.target ?? {},
      risk: parsed.risk ?? "medium",
      id: `wrk_${randomUUID()}`,
      createdAt: now,
      updatedAt: now
    });
    const evaluations = this.policy.evaluateWorkItem(initial, subject, "create");
    const decision = this.policy.summarize(evaluations);
    const status: WorkItem["status"] =
      decision.decision === "deny" ? "blocked" : decision.decision === "require_approval" ? "needs_approval" : "approved";
    const workItem = workItemSchema.parse({ ...initial, status, updatedAt: now });
    const policy: HostedPolicyReceipt = {
      decision: decision.decision,
      reason: decision.reason,
      evaluations: evaluations.map((evaluation) => ({
        actionHash: evaluation.actionHash,
        decision: evaluation.decision.decision,
        reason: evaluation.decision.reason
      }))
    };

    await this.sql.begin(async (tx) => {
      await tx`
        INSERT INTO acs_hosted_work_items(
          id, title, requester, requester_subject, status, intent, target_json, actions_json,
          risk, metadata_json, policy_json, created_at, updated_at
        ) VALUES (
          ${workItem.id}, ${workItem.title}, ${workItem.requester}, ${workItem.requesterSubject ?? null},
          ${workItem.status}, ${workItem.intent}, ${JSON.stringify(workItem.target)}::jsonb,
          ${JSON.stringify(workItem.requestedActions)}::jsonb, ${workItem.risk},
          ${workItem.metadata ? JSON.stringify(workItem.metadata) : null}::jsonb,
          ${JSON.stringify(policy)}::jsonb, ${workItem.createdAt}, ${workItem.updatedAt}
        )
      `;
      await this.appendAudit(tx as unknown as Sql, {
        eventType: "work_item.created",
        actor: subject,
        workItemId: workItem.id,
        payload: { status: workItem.status, risk: workItem.risk, policy }
      });
    });
    return workItem;
  }

  async get(id: string): Promise<WorkItem | undefined> {
    const rows = await this.sql<StoredWorkItemRow[]>`SELECT * FROM acs_hosted_work_items WHERE id = ${id} LIMIT 1`;
    return rows[0] ? rowToWorkItem(rows[0]) : undefined;
  }

  async list(input: unknown = {}): Promise<WorkItem[]> {
    const parsed = hostedListWorkItemsSchema.parse(input);
    const rows = parsed.status
      ? await this.sql<StoredWorkItemRow[]>`
          SELECT * FROM acs_hosted_work_items WHERE status = ${parsed.status}
          ORDER BY created_at DESC LIMIT ${parsed.limit}
        `
      : await this.sql<StoredWorkItemRow[]>`
          SELECT * FROM acs_hosted_work_items ORDER BY created_at DESC LIMIT ${parsed.limit}
        `;
    return rows.map(rowToWorkItem);
  }

  async countPending(): Promise<number> {
    const rows = await this.sql<{ count: string | number }[]>`
      SELECT count(*)::text AS count FROM acs_hosted_work_items
      WHERE status IN ('draft','pending_policy','needs_approval','approved','running')
    `;
    return Number(rows[0]?.count ?? 0);
  }

  async approve(id: string, input: unknown, subject: string): Promise<WorkItem> {
    const parsed = hostedApprovalSchema.parse(input);
    return this.sql.begin(async (tx) => {
      const rows = await tx<StoredWorkItemRow[]>`SELECT * FROM acs_hosted_work_items WHERE id = ${id} FOR UPDATE`;
      const row = rows[0];
      if (!row) throw new Error("work_item_not_found");
      const item = rowToWorkItem(row);
      if (item.status !== "needs_approval") throw new Error("work_item_not_awaiting_approval");
      const policy = hostedPolicy(row.policy_json);
      const required = policy.evaluations.filter((evaluation) => evaluation.decision === "require_approval");
      if (!required.some((evaluation) => evaluation.actionHash === parsed.actionHash)) {
        throw new Error("approval_action_mismatch");
      }
      const approvalId = `apr_${randomUUID()}`;
      const now = new Date().toISOString();
      await tx`
        INSERT INTO acs_hosted_approvals(id, work_item_id, action_hash, approved_by, reason, created_at)
        VALUES (${approvalId}, ${id}, ${parsed.actionHash}, ${subject}, ${parsed.reason}, ${now})
        ON CONFLICT (work_item_id, action_hash) DO NOTHING
      `;
      const approved = await tx<{ action_hash: string }[]>`
        SELECT action_hash FROM acs_hosted_approvals WHERE work_item_id = ${id}
      `;
      const approvedHashes = new Set(approved.map((entry) => entry.action_hash));
      const nextStatus = required.every((entry) => approvedHashes.has(entry.actionHash)) ? "approved" : "needs_approval";
      await tx`UPDATE acs_hosted_work_items SET status = ${nextStatus}, updated_at = ${now} WHERE id = ${id}`;
      await this.appendAudit(tx as unknown as Sql, {
        eventType: "work_item.approval_recorded",
        actor: subject,
        workItemId: id,
        payload: { actionHash: parsed.actionHash, status: nextStatus }
      });
      return workItemSchema.parse({ ...item, status: nextStatus, updatedAt: now });
    });
  }

  async terminalTransition(id: string, operation: "cancel" | "reject", input: unknown, subject: string): Promise<WorkItem> {
    const parsed = hostedReasonSchema.parse(input);
    const status = operation === "cancel" ? "cancelled" : "rejected";
    return this.sql.begin(async (tx) => {
      const rows = await tx<StoredWorkItemRow[]>`SELECT * FROM acs_hosted_work_items WHERE id = ${id} FOR UPDATE`;
      const row = rows[0];
      if (!row) throw new Error("work_item_not_found");
      const item = rowToWorkItem(row);
      if (["succeeded", "failed", "cancelled", "rejected"].includes(item.status)) throw new Error("work_item_terminal");
      const now = new Date().toISOString();
      await tx`UPDATE acs_hosted_work_items SET status = ${status}, updated_at = ${now} WHERE id = ${id}`;
      await this.appendAudit(tx as unknown as Sql, {
        eventType: `work_item.${status}`,
        actor: subject,
        workItemId: id,
        payload: { reason: parsed.reason ?? null }
      });
      return workItemSchema.parse({ ...item, status, updatedAt: now });
    });
  }

  async unblock(id: string, subject: string): Promise<WorkItem> {
    return this.sql.begin(async (tx) => {
      const rows = await tx<StoredWorkItemRow[]>`SELECT * FROM acs_hosted_work_items WHERE id = ${id} FOR UPDATE`;
      const row = rows[0];
      if (!row) throw new Error("work_item_not_found");
      const item = rowToWorkItem(row);
      if (item.status !== "blocked") throw new Error("work_item_not_blocked");
      const evaluations = this.policy.evaluateWorkItem(item, subject, "unblock");
      const decision = this.policy.summarize(evaluations);
      const status: WorkItem["status"] =
        decision.decision === "deny" ? "blocked" : decision.decision === "require_approval" ? "needs_approval" : "approved";
      const policy: HostedPolicyReceipt = {
        decision: decision.decision,
        reason: decision.reason,
        evaluations: evaluations.map((evaluation) => ({
          actionHash: evaluation.actionHash,
          decision: evaluation.decision.decision,
          reason: evaluation.decision.reason
        }))
      };
      const now = new Date().toISOString();
      await tx`
        UPDATE acs_hosted_work_items SET status = ${status}, policy_json = ${JSON.stringify(policy)}::jsonb,
        updated_at = ${now} WHERE id = ${id}
      `;
      await this.appendAudit(tx as unknown as Sql, {
        eventType: "work_item.unblock_evaluated",
        actor: subject,
        workItemId: id,
        payload: { status, policy }
      });
      return workItemSchema.parse({ ...item, status, updatedAt: now });
    });
  }

  async claim(input: unknown, workerId: string): Promise<HostedClaim | undefined> {
    const parsed = hostedClaimSchema.parse(input);
    const leaseMs = Math.min(parsed.leaseMs ?? this.config.maxLeaseMs, this.config.maxLeaseMs);
    return this.sql.begin(async (tx) => {
      const expired = await tx<{ work_item_id: string }[]>`
        UPDATE acs_hosted_leases l SET completed_at = now()
        FROM acs_hosted_work_items w
        WHERE l.work_item_id = w.id AND l.completed_at IS NULL AND l.expires_at <= now() AND w.status = 'running'
        RETURNING l.work_item_id
      `;
      for (const entry of expired) {
        await tx`UPDATE acs_hosted_work_items SET status = 'failed', result_json = ${JSON.stringify({ category: "lease_expired" })}::jsonb, updated_at = now() WHERE id = ${entry.work_item_id}`;
        await this.appendAudit(tx as unknown as Sql, {
          eventType: "work_item.lease_expired",
          actor: "system",
          workItemId: entry.work_item_id,
          payload: { failClosed: true }
        });
      }

      const rows = await tx<StoredWorkItemRow[]>`
        SELECT * FROM acs_hosted_work_items WHERE status = 'approved'
        ORDER BY created_at ASC FOR UPDATE SKIP LOCKED LIMIT 1
      `;
      const row = rows[0];
      if (!row) return undefined;
      const workItem = rowToWorkItem(row);
      const policy = hostedPolicy(row.policy_json);
      const actionHashes = policy.evaluations.map((entry) => entry.actionHash);
      const actionHash = stableHash({ workItemId: workItem.id, actionHashes });
      const planHash = stableHash({ schemaVersion: "acs.hosted-plan.v1", workItemId: workItem.id, actions: workItem.requestedActions });
      const leaseId = `lease_${randomUUID()}`;
      const leaseToken = randomBytes(32).toString("base64url");
      const leaseTokenHash = sha256(leaseToken);
      const now = new Date();
      const expiresAt = new Date(now.getTime() + leaseMs).toISOString();
      await tx`
        INSERT INTO acs_hosted_leases(id, work_item_id, worker_id, lease_token_hash, action_hash, plan_hash, expires_at, created_at)
        VALUES (${leaseId}, ${workItem.id}, ${workerId}, ${leaseTokenHash}, ${actionHash}, ${planHash}, ${expiresAt}, ${now.toISOString()})
      `;
      await tx`UPDATE acs_hosted_work_items SET status = 'running', updated_at = ${now.toISOString()} WHERE id = ${workItem.id}`;
      await this.appendAudit(tx as unknown as Sql, {
        eventType: "work_item.claimed",
        actor: workerId,
        workItemId: workItem.id,
        payload: { leaseId, actionHash, planHash, expiresAt }
      });
      return {
        workItem: workItemSchema.parse({ ...workItem, status: "running", updatedAt: now.toISOString() }),
        leaseId,
        leaseToken,
        workerId,
        actionHash,
        planHash,
        leaseExpiresAt: expiresAt
      };
    });
  }

  async submitResult(input: unknown, authenticatedWorkerId: string, leaseToken: string): Promise<WorkItem> {
    const parsed = submitWorkResultSchema.parse(input);
    if (parsed.workerId !== authenticatedWorkerId) throw new Error("worker_identity_mismatch");
    return this.sql.begin(async (tx) => {
      const replay = await tx<{ result_json: unknown }[]>`
        SELECT result_json FROM acs_hosted_result_idempotency WHERE idempotency_key = ${parsed.idempotencyKey}
      `;
      if (replay[0]) return workItemSchema.parse(replay[0].result_json);

      const leases = await tx<{
        work_item_id: string;
        worker_id: string;
        lease_token_hash: string;
        action_hash: string;
        plan_hash: string;
        expires_at: Date | string;
        completed_at: Date | string | null;
      }[]>`SELECT * FROM acs_hosted_leases WHERE id = ${parsed.leaseId} FOR UPDATE`;
      const lease = leases[0];
      if (!lease || lease.work_item_id !== parsed.workItemId) throw new Error("lease_not_found");
      if (lease.worker_id !== authenticatedWorkerId) throw new Error("lease_worker_mismatch");
      if (lease.completed_at) throw new Error("lease_already_completed");
      if (sha256(leaseToken) !== lease.lease_token_hash) throw new Error("invalid_lease_token");
      if (Date.parse(String(lease.expires_at)) <= Date.now()) throw new Error("lease_expired");
      if (lease.action_hash !== parsed.actionHash) throw new Error("result_action_hash_mismatch");
      if (parsed.planHash && lease.plan_hash !== parsed.planHash) throw new Error("result_plan_hash_mismatch");

      const rows = await tx<StoredWorkItemRow[]>`SELECT * FROM acs_hosted_work_items WHERE id = ${parsed.workItemId} FOR UPDATE`;
      const row = rows[0];
      if (!row) throw new Error("work_item_not_found");
      const item = rowToWorkItem(row);
      if (item.status !== "running") throw new Error("work_item_not_running");
      const status: WorkItem["status"] =
        parsed.outcome === "succeeded"
          ? "succeeded"
          : parsed.outcome === "cancelled"
            ? "cancelled"
            : parsed.outcome === "blocked"
              ? "blocked"
              : "failed";
      const now = new Date().toISOString();
      const updated = workItemSchema.parse({ ...item, status, result: parsed, updatedAt: now });
      await tx`
        UPDATE acs_hosted_work_items SET status = ${status}, result_json = ${JSON.stringify(parsed)}::jsonb, updated_at = ${now}
        WHERE id = ${parsed.workItemId}
      `;
      await tx`UPDATE acs_hosted_leases SET completed_at = ${now} WHERE id = ${parsed.leaseId}`;
      await tx`
        INSERT INTO acs_hosted_result_idempotency(idempotency_key, work_item_id, result_json, created_at)
        VALUES (${parsed.idempotencyKey}, ${parsed.workItemId}, ${JSON.stringify(updated)}::jsonb, ${now})
      `;
      await this.appendAudit(tx as unknown as Sql, {
        eventType: `work_item.${status}`,
        actor: authenticatedWorkerId,
        workItemId: parsed.workItemId,
        payload: { leaseId: parsed.leaseId, actionHash: parsed.actionHash, outcome: parsed.outcome }
      });
      return updated;
    });
  }

  async auditEvents(workItemId: string, limit = 100): Promise<unknown[]> {
    return this.sql`
      SELECT sequence, event_id AS "eventId", event_type AS "eventType", actor, work_item_id AS "workItemId",
             payload_json AS payload, previous_hash AS "previousHash", event_hash AS "eventHash", created_at AS "createdAt"
      FROM acs_hosted_audit_events WHERE work_item_id = ${workItemId}
      ORDER BY sequence DESC LIMIT ${Math.min(Math.max(limit, 1), 200)}
    `;
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }

  private async appendAudit(
    tx: Sql,
    event: { eventType: string; actor: string; workItemId?: string; payload: Record<string, unknown> }
  ): Promise<void> {
    const heads = await tx<{ sequence: string | number; event_hash: string }[]>`
      SELECT sequence, event_hash FROM acs_hosted_audit_head WHERE singleton = true FOR UPDATE
    `;
    const previousSequence = Number(heads[0]?.sequence ?? 0);
    const previousHash = heads[0]?.event_hash ?? "";
    const sequence = previousSequence + 1;
    const eventId = `evt_${randomUUID()}`;
    const createdAt = new Date().toISOString();
    const eventHash = stableHash({
      schemaVersion: "acs.hosted-audit.v1",
      sequence,
      eventId,
      eventType: event.eventType,
      actor: event.actor,
      workItemId: event.workItemId ?? null,
      payload: event.payload,
      previousHash,
      createdAt
    });
    await tx`
      INSERT INTO acs_hosted_audit_events(sequence, event_id, event_type, actor, work_item_id, payload_json, previous_hash, event_hash, created_at)
      VALUES (${sequence}, ${eventId}, ${event.eventType}, ${event.actor}, ${event.workItemId ?? null},
              ${JSON.stringify(event.payload)}::jsonb, ${previousHash}, ${eventHash}, ${createdAt})
    `;
    await tx`UPDATE acs_hosted_audit_head SET sequence = ${sequence}, event_hash = ${eventHash} WHERE singleton = true`;
  }
}

function rowToWorkItem(row: StoredWorkItemRow): WorkItem {
  return workItemSchema.parse({
    id: row.id,
    title: row.title,
    requester: row.requester,
    ...(row.requester_subject ? { requesterSubject: row.requester_subject } : {}),
    status: row.status,
    intent: row.intent,
    target: row.target_json,
    requestedActions: row.actions_json,
    risk: row.risk,
    ...(row.metadata_json ? { metadata: row.metadata_json } : {}),
    ...(row.result_json ? { result: row.result_json } : {}),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  });
}

function hostedPolicy(value: unknown): HostedPolicyReceipt {
  return z
    .object({
      decision: z.string(),
      reason: z.string(),
      evaluations: z.array(z.object({ actionHash: z.string(), decision: z.string(), reason: z.string() }))
    })
    .parse(value);
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
