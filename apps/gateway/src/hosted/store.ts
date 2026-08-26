import { createHash, randomBytes, randomUUID } from "node:crypto";
import postgres, { type Sql } from "postgres";
import {
  hostedApprovalSchema,
  hostedClaimSchema,
  hostedCreateWorkItemSchema,
  hostedListWorkItemsSchema,
  hostedReasonSchema,
  stableHash,
  submitWorkResultSchema,
  workItemSchema,
  type WorkItem
} from "./contracts.js";
import type { HostedGatewayConfig } from "./config.js";
import { evaluateHostedPolicy, type HostedPolicyReceipt } from "./policy.js";

export interface HostedClaim {
  readonly workItem: WorkItem;
  readonly leaseId: string;
  readonly leaseToken: string;
  readonly workerId: string;
  readonly actionHash: string;
  readonly planHash: string;
  readonly leaseExpiresAt: string;
}

type Row = {
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
};

export class HostedStore {
  private readonly sql: Sql;

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
    await this.sql`INSERT INTO acs_hosted_audit_head(singleton, sequence, event_hash) VALUES (true, 0, '') ON CONFLICT (singleton) DO NOTHING`;
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

  async health(): Promise<{ ok: true; auditSequence: number }> {
    const rows = await this.sql<{ sequence: string | number }[]>`SELECT sequence FROM acs_hosted_audit_head WHERE singleton = true`;
    if (!rows[0]) throw new Error("audit_head_missing");
    return { ok: true, auditSequence: Number(rows[0].sequence) };
  }

  async countPending(): Promise<number> {
    const rows = await this.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM acs_hosted_work_items
      WHERE status IN ('draft','pending_policy','needs_approval','approved','running')
    `;
    return Number(rows[0]?.count ?? 0);
  }

  async create(input: unknown, subject: string): Promise<WorkItem> {
    const parsed = hostedCreateWorkItemSchema.parse(input);
    const now = new Date().toISOString();
    const draft = workItemSchema.parse({
      id: `wrk_${randomUUID()}`,
      title: parsed.title,
      requester: "agent",
      requesterSubject: subject,
      status: "pending_policy",
      intent: parsed.intent,
      target: parsed.target ?? {},
      requestedActions: parsed.requestedActions,
      risk: parsed.risk ?? "medium",
      ...(parsed.metadata ? { metadata: parsed.metadata } : {}),
      createdAt: now,
      updatedAt: now
    });
    const policy = evaluateHostedPolicy(draft, subject, "create");
    const status = statusFromPolicy(policy);
    const item = workItemSchema.parse({ ...draft, status });

    await this.sql.begin(async (tx) => {
      await tx`
        INSERT INTO acs_hosted_work_items(
          id,title,requester,requester_subject,status,intent,target_json,actions_json,risk,metadata_json,policy_json,created_at,updated_at
        ) VALUES (
          ${item.id},${item.title},${item.requester},${item.requesterSubject ?? null},${item.status},${item.intent},
          ${tx.json(item.target)},${tx.json(item.requestedActions)},${item.risk},
          ${item.metadata ? tx.json(item.metadata) : null},${tx.json(policy)},${item.createdAt},${item.updatedAt}
        )
      `;
      await appendAudit(tx, "work_item.created", subject, item.id, { status, risk: item.risk, policy });
    });
    return item;
  }

  async get(id: string): Promise<WorkItem | undefined> {
    const rows = await this.sql<Row[]>`SELECT * FROM acs_hosted_work_items WHERE id = ${id} LIMIT 1`;
    return rows[0] ? rowToItem(rows[0]) : undefined;
  }

  async list(input: unknown = {}): Promise<WorkItem[]> {
    const parsed = hostedListWorkItemsSchema.parse(input);
    const rows = parsed.status
      ? await this.sql<Row[]>`SELECT * FROM acs_hosted_work_items WHERE status = ${parsed.status} ORDER BY created_at DESC LIMIT ${parsed.limit}`
      : await this.sql<Row[]>`SELECT * FROM acs_hosted_work_items ORDER BY created_at DESC LIMIT ${parsed.limit}`;
    return rows.map(rowToItem);
  }

  async approve(id: string, input: unknown, subject: string): Promise<WorkItem> {
    const parsed = hostedApprovalSchema.parse(input);
    return this.sql.begin(async (tx) => {
      const rows = await tx<Row[]>`SELECT * FROM acs_hosted_work_items WHERE id = ${id} FOR UPDATE`;
      const row = requiredRow(rows[0]);
      const item = rowToItem(row);
      if (item.status !== "needs_approval") throw new Error("work_item_not_awaiting_approval");
      const policy = policyReceipt(row.policy_json);
      const required = policy.evaluations.filter((entry) => entry.decision === "require_approval");
      if (!required.some((entry) => entry.actionHash === parsed.actionHash)) throw new Error("approval_action_mismatch");
      const now = new Date().toISOString();
      await tx`
        INSERT INTO acs_hosted_approvals(id,work_item_id,action_hash,approved_by,reason,created_at)
        VALUES (${`apr_${randomUUID()}`},${id},${parsed.actionHash},${subject},${parsed.reason},${now})
        ON CONFLICT (work_item_id, action_hash) DO NOTHING
      `;
      const approved = await tx<{ action_hash: string }[]>`SELECT action_hash FROM acs_hosted_approvals WHERE work_item_id = ${id}`;
      const hashes = new Set(approved.map((entry) => entry.action_hash));
      const status = required.every((entry) => hashes.has(entry.actionHash)) ? "approved" : "needs_approval";
      await tx`UPDATE acs_hosted_work_items SET status = ${status}, updated_at = ${now} WHERE id = ${id}`;
      await appendAudit(tx, "work_item.approval_recorded", subject, id, { actionHash: parsed.actionHash, status });
      return workItemSchema.parse({ ...item, status, updatedAt: now });
    });
  }

  async terminal(id: string, operation: "cancel" | "reject", input: unknown, subject: string): Promise<WorkItem> {
    const parsed = hostedReasonSchema.parse(input);
    const status = operation === "cancel" ? "cancelled" : "rejected";
    return this.sql.begin(async (tx) => {
      const rows = await tx<Row[]>`SELECT * FROM acs_hosted_work_items WHERE id = ${id} FOR UPDATE`;
      const item = rowToItem(requiredRow(rows[0]));
      if (["succeeded", "failed", "cancelled", "rejected"].includes(item.status)) throw new Error("work_item_terminal");
      const now = new Date().toISOString();
      await tx`UPDATE acs_hosted_work_items SET status = ${status}, updated_at = ${now} WHERE id = ${id}`;
      await appendAudit(tx, `work_item.${status}`, subject, id, { reason: parsed.reason ?? null });
      return workItemSchema.parse({ ...item, status, updatedAt: now });
    });
  }

  async unblock(id: string, subject: string): Promise<WorkItem> {
    return this.sql.begin(async (tx) => {
      const rows = await tx<Row[]>`SELECT * FROM acs_hosted_work_items WHERE id = ${id} FOR UPDATE`;
      const row = requiredRow(rows[0]);
      const item = rowToItem(row);
      if (item.status !== "blocked") throw new Error("work_item_not_blocked");
      const policy = evaluateHostedPolicy(item, subject, "unblock");
      const status = statusFromPolicy(policy);
      const now = new Date().toISOString();
      await tx`UPDATE acs_hosted_work_items SET status = ${status}, policy_json = ${tx.json(policy)}, updated_at = ${now} WHERE id = ${id}`;
      await appendAudit(tx, "work_item.unblock_evaluated", subject, id, { status, policy });
      return workItemSchema.parse({ ...item, status, updatedAt: now });
    });
  }

  async claim(input: unknown, workerId: string): Promise<HostedClaim | undefined> {
    const parsed = hostedClaimSchema.parse(input);
    const leaseMs = Math.min(parsed.leaseMs ?? this.config.maxLeaseMs, this.config.maxLeaseMs);
    return this.sql.begin(async (tx) => {
      const expired = await tx<{ work_item_id: string }[]>`
        UPDATE acs_hosted_leases AS l SET completed_at = now()
        FROM acs_hosted_work_items AS w
        WHERE l.work_item_id = w.id AND l.completed_at IS NULL AND l.expires_at <= now() AND w.status = 'running'
        RETURNING l.work_item_id
      `;
      for (const entry of expired) {
        await tx`UPDATE acs_hosted_work_items SET status = 'failed', result_json = ${tx.json({ category: "lease_expired" })}, updated_at = now() WHERE id = ${entry.work_item_id}`;
        await appendAudit(tx, "work_item.lease_expired", "system", entry.work_item_id, { failClosed: true });
      }

      const rows = await tx<Row[]>`
        SELECT * FROM acs_hosted_work_items WHERE status = 'approved'
        ORDER BY created_at ASC FOR UPDATE SKIP LOCKED LIMIT 1
      `;
      if (!rows[0]) return undefined;
      const item = rowToItem(rows[0]);
      const policy = policyReceipt(rows[0].policy_json);
      const actionHash = stableHash({ workItemId: item.id, actionHashes: policy.evaluations.map((entry) => entry.actionHash) });
      const planHash = stableHash({ schemaVersion: "acs.hosted-plan.v1", workItemId: item.id, actions: item.requestedActions });
      const leaseId = `lease_${randomUUID()}`;
      const leaseToken = randomBytes(32).toString("base64url");
      const now = new Date();
      const expiresAt = new Date(now.getTime() + leaseMs).toISOString();
      await tx`
        INSERT INTO acs_hosted_leases(id,work_item_id,worker_id,lease_token_hash,action_hash,plan_hash,expires_at,created_at)
        VALUES (${leaseId},${item.id},${workerId},${sha256(leaseToken)},${actionHash},${planHash},${expiresAt},${now.toISOString()})
      `;
      await tx`UPDATE acs_hosted_work_items SET status = 'running', updated_at = ${now.toISOString()} WHERE id = ${item.id}`;
      await appendAudit(tx, "work_item.claimed", workerId, item.id, { leaseId, actionHash, planHash, expiresAt });
      return {
        workItem: workItemSchema.parse({ ...item, status: "running", updatedAt: now.toISOString() }),
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
        work_item_id: string; worker_id: string; lease_token_hash: string; action_hash: string; plan_hash: string;
        expires_at: Date | string; completed_at: Date | string | null;
      }[]>`SELECT * FROM acs_hosted_leases WHERE id = ${parsed.leaseId} FOR UPDATE`;
      const lease = leases[0];
      if (!lease || lease.work_item_id !== parsed.workItemId) throw new Error("lease_not_found");
      if (lease.worker_id !== authenticatedWorkerId) throw new Error("lease_worker_mismatch");
      if (lease.completed_at) throw new Error("lease_already_completed");
      if (sha256(leaseToken) !== lease.lease_token_hash) throw new Error("invalid_lease_token");
      if (Date.parse(String(lease.expires_at)) <= Date.now()) throw new Error("lease_expired");
      if (lease.action_hash !== parsed.actionHash) throw new Error("result_action_hash_mismatch");
      if (parsed.planHash && lease.plan_hash !== parsed.planHash) throw new Error("result_plan_hash_mismatch");

      const rows = await tx<Row[]>`SELECT * FROM acs_hosted_work_items WHERE id = ${parsed.workItemId} FOR UPDATE`;
      const item = rowToItem(requiredRow(rows[0]));
      if (item.status !== "running") throw new Error("work_item_not_running");
      const status: WorkItem["status"] = parsed.outcome === "succeeded"
        ? "succeeded"
        : parsed.outcome === "cancelled"
          ? "cancelled"
          : parsed.outcome === "blocked"
            ? "blocked"
            : "failed";
      const now = new Date().toISOString();
      const updated = workItemSchema.parse({ ...item, status, result: parsed, updatedAt: now });
      await tx`UPDATE acs_hosted_work_items SET status = ${status}, result_json = ${tx.json(parsed)}, updated_at = ${now} WHERE id = ${parsed.workItemId}`;
      await tx`UPDATE acs_hosted_leases SET completed_at = ${now} WHERE id = ${parsed.leaseId}`;
      await tx`
        INSERT INTO acs_hosted_result_idempotency(idempotency_key,work_item_id,result_json,created_at)
        VALUES (${parsed.idempotencyKey},${parsed.workItemId},${tx.json(updated)},${now})
      `;
      await appendAudit(tx, `work_item.${status}`, authenticatedWorkerId, parsed.workItemId, {
        leaseId: parsed.leaseId,
        actionHash: parsed.actionHash,
        outcome: parsed.outcome
      });
      return updated;
    });
  }

  async auditEvents(workItemId: string, limit = 100): Promise<unknown[]> {
    const bounded = Math.min(Math.max(Number.isFinite(limit) ? Math.trunc(limit) : 100, 1), 200);
    return this.sql`
      SELECT sequence,event_id AS "eventId",event_type AS "eventType",actor,work_item_id AS "workItemId",
             payload_json AS payload,previous_hash AS "previousHash",event_hash AS "eventHash",created_at AS "createdAt"
      FROM acs_hosted_audit_events WHERE work_item_id = ${workItemId}
      ORDER BY sequence DESC LIMIT ${bounded}
    `;
  }
}

function rowToItem(row: Row): WorkItem {
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

function statusFromPolicy(policy: HostedPolicyReceipt): WorkItem["status"] {
  return policy.decision === "deny" ? "blocked" : policy.decision === "require_approval" ? "needs_approval" : "approved";
}

function policyReceipt(value: unknown): HostedPolicyReceipt {
  if (!value || typeof value !== "object") throw new Error("policy_receipt_missing");
  return value as HostedPolicyReceipt;
}

function requiredRow(row: Row | undefined): Row {
  if (!row) throw new Error("work_item_not_found");
  return row;
}

async function appendAudit(
  tx: Sql,
  eventType: string,
  actor: string,
  workItemId: string | undefined,
  payload: Record<string, unknown>
): Promise<void> {
  const heads = await tx<{ sequence: string | number; event_hash: string }[]>`
    SELECT sequence,event_hash FROM acs_hosted_audit_head WHERE singleton = true FOR UPDATE
  `;
  if (!heads[0]) throw new Error("audit_head_missing");
  const sequence = Number(heads[0].sequence) + 1;
  const previousHash = heads[0].event_hash;
  const eventId = `evt_${randomUUID()}`;
  const createdAt = new Date().toISOString();
  const eventHash = stableHash({
    schemaVersion: "acs.hosted-audit.v1",
    sequence,eventId,eventType,actor,workItemId: workItemId ?? null,payload,previousHash,createdAt
  });
  await tx`
    INSERT INTO acs_hosted_audit_events(sequence,event_id,event_type,actor,work_item_id,payload_json,previous_hash,event_hash,created_at)
    VALUES (${sequence},${eventId},${eventType},${actor},${workItemId ?? null},${tx.json(payload)},${previousHash},${eventHash},${createdAt})
  `;
  await tx`UPDATE acs_hosted_audit_head SET sequence = ${sequence}, event_hash = ${eventHash} WHERE singleton = true`;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
