import { SqliteWorkItemStore, type WorkItem, type WorkItemStore } from "@agent-control-stack/work-items";
import { z } from "zod";
import { createPolicyEngine, type PolicyEngine } from "./policy.js";
import { approvalRequired } from "./tools.js";

const positiveInteger = z.number().int().positive();

export interface PendingApprovalDigestEntry {
  workItemId: string;
  actionHash: string;
  updatedAt: string;
  ageMinutes: number;
}

export interface PendingApprovalDigest {
  kind: "pending_approval_digest";
  generatedAt: string;
  olderThanMinutes: number;
  count: number;
  items: PendingApprovalDigestEntry[];
}

export interface PendingApprovalDigestConfig {
  enabled: boolean;
  olderThanMinutes: number;
  webhookUrl?: string;
  stdout: boolean;
  dbPath: string;
  actor: string;
}

export interface CollectPendingApprovalDigestInput {
  workItems: WorkItem[];
  policy: PolicyEngine;
  actor: string;
  olderThanMinutes: number;
  now?: Date;
}

export interface DeliverPendingApprovalDigestOptions {
  stdout?: boolean;
  webhookUrl?: string;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
}

/**
 * Optional ops digest of work items stuck in needs_approval (policy
 * `require_approval`) longer than N minutes. Default off (local-first).
 *
 * Payload is intentionally minimal: work item id + exact action hash only
 * (plus age metadata). No action params, titles, intents, or secrets.
 */
export function loadPendingApprovalDigestConfig(env: NodeJS.ProcessEnv = process.env): PendingApprovalDigestConfig {
  const enabled = parseEnabled(env.ACS_PENDING_APPROVAL_DIGEST_ENABLED);
  const olderThanMinutes = positiveInteger.parse(
    env.ACS_PENDING_APPROVAL_DIGEST_OLDER_THAN_MINUTES === undefined
      ? 30
      : Number(env.ACS_PENDING_APPROVAL_DIGEST_OLDER_THAN_MINUTES)
  );
  const webhookUrl = env.ACS_PENDING_APPROVAL_DIGEST_WEBHOOK_URL?.trim() || undefined;
  if (webhookUrl) {
    const parsed = new URL(webhookUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("ACS_PENDING_APPROVAL_DIGEST_WEBHOOK_URL must be http(s)");
    }
  }
  const stdoutEnv = env.ACS_PENDING_APPROVAL_DIGEST_STDOUT?.trim().toLowerCase();
  const stdout =
    stdoutEnv === undefined || stdoutEnv === ""
      ? true
      : stdoutEnv === "1" || stdoutEnv === "true" || stdoutEnv === "yes";
  return {
    enabled,
    olderThanMinutes,
    ...(webhookUrl ? { webhookUrl } : {}),
    stdout,
    dbPath: env.ACS_DB_PATH?.trim() || "storage/local.db",
    actor: env.ACS_PENDING_APPROVAL_DIGEST_ACTOR?.trim() || "ops-digest"
  };
}

export function collectPendingApprovalDigest(
  input: CollectPendingApprovalDigestInput
): PendingApprovalDigest | undefined {
  const now = input.now ?? new Date();
  const olderThanMs = input.olderThanMinutes * 60_000;
  const stale = input.workItems
    .filter((workItem) => workItem.status === "needs_approval")
    .filter((workItem) => {
      const updatedAtMs = Date.parse(workItem.updatedAt);
      return Number.isFinite(updatedAtMs) && now.getTime() - updatedAtMs >= olderThanMs;
    })
    .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id));

  const items: PendingApprovalDigestEntry[] = [];
  for (const workItem of stale) {
    const required = approvalRequired(input.policy.evaluateWorkItem(workItem, input.actor, "approve"));
    const updatedAtMs = Date.parse(workItem.updatedAt);
    const ageMinutes = Math.floor((now.getTime() - updatedAtMs) / 60_000);
    for (const evaluation of required) {
      items.push({
        workItemId: workItem.id,
        actionHash: evaluation.actionHash,
        updatedAt: workItem.updatedAt,
        ageMinutes
      });
    }
  }

  if (items.length === 0) {
    return undefined;
  }

  return {
    kind: "pending_approval_digest",
    generatedAt: now.toISOString(),
    olderThanMinutes: input.olderThanMinutes,
    count: items.length,
    items
  };
}

export async function deliverPendingApprovalDigest(
  digest: PendingApprovalDigest,
  options: DeliverPendingApprovalDigestOptions = {}
): Promise<{ stdout: boolean; webhook: boolean }> {
  const line = `${JSON.stringify(digest)}\n`;
  let wroteStdout = false;
  let postedWebhook = false;

  if (options.stdout !== false) {
    (options.log ?? ((chunk: string) => process.stdout.write(chunk)))(line);
    wroteStdout = true;
  }

  if (options.webhookUrl) {
    const fetchImpl = options.fetchImpl ?? fetch;
    const response = await fetchImpl(options.webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(digest)
    });
    if (!response.ok) {
      throw new Error(`pending-approval digest webhook failed: HTTP ${response.status}`);
    }
    postedWebhook = true;
  }

  return { stdout: wroteStdout, webhook: postedWebhook };
}

export interface RunPendingApprovalDigestOnceOptions {
  env?: NodeJS.ProcessEnv;
  config?: PendingApprovalDigestConfig;
  store?: Pick<WorkItemStore, "list"> & { close?: () => void };
  policy?: PolicyEngine;
  now?: Date;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
}

/**
 * One-shot runner. Silent when disabled or when the stale queue is empty.
 * Emits at most one digest per invocation.
 */
export async function runPendingApprovalDigestOnce(
  options: RunPendingApprovalDigestOnceOptions = {}
): Promise<PendingApprovalDigest | undefined> {
  const config = options.config ?? loadPendingApprovalDigestConfig(options.env ?? process.env);
  if (!config.enabled) {
    return undefined;
  }

  const ownsStore = !options.store;
  const store = options.store ?? new SqliteWorkItemStore(config.dbPath);
  try {
    const digest = collectPendingApprovalDigest({
      workItems: store.list({ status: "needs_approval" }),
      policy: options.policy ?? createPolicyEngine(),
      actor: config.actor,
      olderThanMinutes: config.olderThanMinutes,
      now: options.now
    });
    if (!digest) {
      return undefined;
    }
    await deliverPendingApprovalDigest(digest, {
      stdout: config.stdout,
      webhookUrl: config.webhookUrl,
      fetchImpl: options.fetchImpl,
      log: options.log
    });
    return digest;
  } finally {
    if (ownsStore) {
      store.close?.();
    }
  }
}

function parseEnabled(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}
