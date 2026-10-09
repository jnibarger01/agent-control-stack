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
