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
 * Local preset: the bridge's own dependencies, proven by the pinned release's
 * `local-readiness` probe (policy loading + bubblewrap self-test) under the same
 * uid/env as the executor. The bridge is not ready merely because it is
 * listening or because the child process was spawned.
 */
function jcLocalNotReadyReasons(authority) {
  const reasons = [];
  if (authority.configuredExecutionMode === 'managed') reasons.push('local preset is configured as managed');
  if (authority.childMode !== 'local') reasons.push('child is not in the local preset');
  if (authority.bridge?.hasUpstreamPair !== true || authority.bridge?.upstreamStarted !== true) {
    reasons.push('jace-commander child not started');
  }
  const runtime = authority.runtime ?? {};
  if (runtime.releaseRequired !== true) {
    reasons.push('pinned installed release is not required (JC_REQUIRE_INSTALLED_RELEASE=1)');
  }
  if (runtime.installedRelease?.readOnly !== true) {
    reasons.push('pinned runtime is not a read-only installed release');
  }
  const local = authority.local ?? {};
  if (local.uidDrop?.configured !== true) {
    reasons.push('executor uid drop (DC_CMD=setpriv/runuser) is not configured');
  }
  const readiness = local.readiness ?? {};
  if (readiness.status === 'pending') {
    reasons.push('local readiness probe has not completed');
  } else {
    if (readiness.status !== 'ok' || readiness.ok !== true) {
      reasons.push(`local readiness probe failed: ${readiness.detail || 'unknown'}`);
    }
    if (readiness.policy?.ok !== true) reasons.push(`local policy is not usable (${readiness.policy?.state || 'unknown'})`);
    if (readiness.sandbox?.ok !== true) reasons.push(`workload sandbox is unavailable (${readiness.sandbox?.detail || 'unknown'})`);
  }
  const enforcement = authority.enforcement ?? {};
  if (enforcement.executionTokenConfigured !== true) reasons.push('gateway execution token not configured');
  return reasons;
}

/**
 * Why a JC bridge cannot execute governed calls right now (empty: it can).
 * The bridge's own /ready uses this; it does not require a client to have
 * initialized yet (jcBridgeReady, used by the edge, additionally does).
 * Mode-aware: the local preset must never be judged by managed-only ACS rules.
 */
export function jcServiceNotReadyReasons(authority) {
  if (!authority || typeof authority !== 'object' || authority.variant !== 'jc') return ['not a Jace Commander bridge'];
  if (authority.childMode === 'local') return jcLocalNotReadyReasons(authority);
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

/**
 * JC readiness uses explicit, non-secret authority assertions only.
 *
 * Managed requires ACS authority material. Local requires the verified local
 * dependencies instead: pinned read-only release, uid-dropped executor, usable
 * policy, and a passing workload sandbox probe.
 */
export function jcBridgeReady(authority) {
  if (!authority || typeof authority !== 'object' || authority.variant !== 'jc') return false;
  if (authority.childMode === 'local') {
    return (
      jcLocalNotReadyReasons(authority).length === 0 &&
      authority.authoritative === true &&
      authority.bridge?.initialized === true
    );
  }
  return !!(
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
