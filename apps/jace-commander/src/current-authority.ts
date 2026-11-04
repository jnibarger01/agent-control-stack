
/** Live ACS state is required in addition to a valid signed capability. */
import type { JcAuthorization } from './contract.js';
import { IntegrationError } from './integrations.js';
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function assertCurrentAuthority(body: unknown, auth: JcAuthorization, principal?: string): void {
  const response = record(body), item = record(response.workItem);
  const leases = Array.isArray(response.attemptLeases) ? response.attemptLeases : [];
  const lease = leases.map(record).find((entry) => entry.leaseId === auth.leaseId);
  const actions = Array.isArray(item.requestedActions) ? item.requestedActions : [];
  const params = record(record(actions[0]).params);
  const actor = principal?.split('|')[0];
  const expectedActor = actor?.startsWith('chatgpt:') ? actor : actor ? 'chatgpt:' + actor : undefined;
  if (item.id !== auth.workItemId || item.status !== 'running' ||
      (expectedActor !== undefined && item.requesterSubject !== expectedActor) ||
      params.contract !== 'acs.jc.v1' || params.tool !== auth.toolName || params.invocationHash !== auth.invocationHash ||
      !lease || lease.workItemId !== auth.workItemId || lease.attemptId !== auth.attemptId ||
      lease.workerId !== 'acs-jc-bridge' || lease.fencingEpoch !== auth.leaseEpoch ||
      lease.planHash !== auth.planHash || lease.status !== 'active' ||
      typeof lease.expiresAt !== 'string' || !(Date.parse(lease.expiresAt) > Date.now()) ||
      (auth.approvalId !== undefined && lease.approvalId !== auth.approvalId)) {
    throw new IntegrationError('JC_AUTHORITY_REVOKED', 'ACS no longer confirms this exact execution authority');
  }
}
