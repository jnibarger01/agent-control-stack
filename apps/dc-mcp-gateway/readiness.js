/**
 * Shared Desktop Commander execution-authority readiness predicate.
 *
 * bridge.js applies it to its own computeAuthority() result for the bridge
 * /ready probe. server.js applies the same function to the bridge's /authority
 * JSON for the public edge /ready probe. Sharing it means the edge can never
 * report ready for an executor lease the bridge itself rejects: ambiguous,
 * expired, malformed, or process-mismatched leases all surface as
 * `ambiguous: true` (the bridge reports `observedMode: "managed"` for such a
 * lease, so the mode alone is not enough).
 *
 * Fail closed: a missing or garbled lease or break-glass report is treated as
 * not ready, never as "not ambiguous".
 */

function unambiguous(status) {
  return !!status && typeof status === 'object' && status.ambiguous === false;
}

/** Execution authority only: canonical lease or break-glass state, no transport. */
export function dcExecutionAuthorityReady(authority, { managed }) {
  if (!authority || typeof authority !== 'object' || authority.variant !== 'dc') return false;
  const executor = authority.executor;
  if (!executor || typeof executor !== 'object') return false;
  if (!unambiguous(executor.lease) || !unambiguous(executor.breakGlass)) return false;
  if (authority.observedMode === 'managed') return executor.lease.active === true;
  // Break-glass execution is never ready on a managed lane.
  return !managed && authority.observedMode === 'break_glass' && executor.breakGlass.active === true;
}

/** Full DC bridge readiness: execution authority plus a started upstream executor pair. */
export function dcBridgeReady(authority, { managed }) {
  return (
    dcExecutionAuthorityReady(authority, { managed }) &&
    authority.bridge?.hasUpstreamPair === true &&
    authority.bridge?.upstreamStarted === true
  );
}

/**
 * Why a managed JC bridge cannot execute governed calls right now (empty: it can).
 * The bridge's own /ready uses this; it does not require a client to have
 * initialized yet (jcBridgeReady, used by the edge, additionally does).
 */
export function jcServiceNotReadyReasons(authority) {
  if (!authority || typeof authority !== 'object' || authority.variant !== 'jc') return ['not a Jace Commander bridge'];
  const reasons = [];
  if (authority.configuredExecutionMode !== 'managed' || authority.childMode !== 'managed') reasons.push('not in managed mode');
  if (authority.bridge?.hasUpstreamPair !== true || authority.bridge?.upstreamStarted !== true) reasons.push('jace-commander child not started');
  const enforcement = authority.enforcement ?? {};
  if (enforcement.executionTokenConfigured !== true) reasons.push('gateway execution token not configured');
  if (enforcement.capabilityVerificationConfigured !== true) reasons.push('ACS capability verification key not configured');
  if (enforcement.currentAuthorityCredentialConfigured !== true) reasons.push('dedicated ACS authority credential (JC_ACS_AUTHORITY_TOKEN_FILE) not configured');
  const runtime = authority.runtime ?? {};
  if (runtime.releaseRequired === true && runtime.installedRelease?.readOnly !== true) reasons.push('pinned runtime is not a read-only installed release');
  return reasons;
}

/** Managed JC readiness uses explicit, non-secret authority assertions only. */
export function jcBridgeReady(authority) {
  return !!(
    authority && typeof authority === 'object' &&
    authority.variant === 'jc' &&
    authority.configuredExecutionMode === 'managed' &&
    authority.childMode === 'managed' &&
    authority.authoritative === true &&
    authority.bridge?.hasUpstreamPair === true &&
    authority.bridge?.upstreamStarted === true &&
    authority.bridge?.initialized === true &&
    authority.enforcement?.executionTokenConfigured === true &&
    authority.enforcement?.capabilityVerificationConfigured === true &&
    authority.enforcement?.currentAuthorityCredentialConfigured === true
  );
}
