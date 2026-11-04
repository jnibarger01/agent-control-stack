/**
 * Live ACS authority check (managed mode, every non-read call).
 *
 * A valid signed acs.jc.v1 capability is necessary but not sufficient: before
 * anything runs, JC re-reads the work item from ACS and requires that ACS
 * still confirms THIS exact execution authority. That makes revocation,
 * cancellation and lease expiry effective immediately (not at capability
 * expiry) and makes an ACS outage a refusal, never a local fallback.
 *
 * The read uses a dedicated read-scoped credential (JC_ACS_AUTHORITY_TOKEN or
 * JC_ACS_AUTHORITY_TOKEN_FILE), distinct from the model-facing acs_read token.
 */
import fs from 'node:fs';
import type { JcAuthorization } from './contract.js';
import { IntegrationError } from './integrations.js';

export const JC_BRIDGE_WORKER_ID = 'acs-jc-bridge';

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Which binding ACS no longer confirms (no secrets; safe to return to the caller). */
export type AuthorityMismatch =
  | 'work_item_mismatch' | 'work_item_not_running' | 'requester_mismatch' | 'action_mismatch'
  | 'lease_missing' | 'lease_binding_mismatch' | 'lease_not_active' | 'lease_expired' | 'approval_mismatch';

export function currentAuthorityMismatch(body: unknown, auth: JcAuthorization, principal?: string, now = Date.now()): AuthorityMismatch | undefined {
  const response = record(body);
  const item = record(response.workItem);
  const leases = Array.isArray(response.attemptLeases) ? response.attemptLeases : [];
  const lease = leases.map(record).find((entry) => entry.leaseId === auth.leaseId);
  const actions = Array.isArray(item.requestedActions) ? item.requestedActions : [];
  // The action this capability was issued for (bound by tool + invocation hash), not merely the first one.
  const action = actions.map(record).find((entry) => {
    const params = record(entry.params);
    return params.tool === auth.toolName && params.invocationHash === auth.invocationHash;
  });
  const params = record(action?.params);
  const actor = principal?.split('|')[0];
  const expectedActor = actor?.startsWith('chatgpt:') ? actor : actor ? 'chatgpt:' + actor : undefined;
  if (item.id !== auth.workItemId) return 'work_item_mismatch';
  if (item.status !== 'running') return 'work_item_not_running';
  if (expectedActor !== undefined && item.requesterSubject !== expectedActor) return 'requester_mismatch';
  if (!action || params.contract !== 'acs.jc.v1') return 'action_mismatch';
  if (!lease) return 'lease_missing';
  if (lease.workItemId !== auth.workItemId || lease.attemptId !== auth.attemptId || lease.workerId !== JC_BRIDGE_WORKER_ID
    || lease.fencingEpoch !== auth.leaseEpoch || lease.planHash !== auth.planHash) return 'lease_binding_mismatch';
  if (lease.status !== 'active') return 'lease_not_active';
  if (typeof lease.expiresAt !== 'string' || !(Date.parse(lease.expiresAt) > now)) return 'lease_expired';
  if (auth.approvalId !== undefined && lease.approvalId !== auth.approvalId) return 'approval_mismatch';
  return undefined;
}

export function assertCurrentAuthority(body: unknown, auth: JcAuthorization, principal?: string): void {
  const mismatch = currentAuthorityMismatch(body, auth, principal);
  if (mismatch) throw new IntegrationError('JC_AUTHORITY_REVOKED', `ACS no longer confirms this exact execution authority (${mismatch})`);
}

/** The read-scoped credential JC uses to confirm authority. Never the model-facing token unless nothing else is set. */
export function authorityToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.JC_ACS_AUTHORITY_TOKEN) return env.JC_ACS_AUTHORITY_TOKEN;
  if (env.JC_ACS_AUTHORITY_TOKEN_FILE) {
    try {
      const value = fs.readFileSync(env.JC_ACS_AUTHORITY_TOKEN_FILE, 'utf8').trim();
      if (value) return value;
    } catch {
      return undefined;
    }
  }
  return env.JC_ACS_TOKEN || undefined;
}
