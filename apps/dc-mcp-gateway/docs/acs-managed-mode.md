# ACS managed mode for desktop-commander-mcp-gateway

Status: implemented on the gateway side against the contract in
`agent-control-stack/docs/protocol/acs-dc-v1-capability-contract.md` (`acs.dc.v1`).

## Authority model (normative)

1. **ACS is the sole capability issuer.** The gateway never mints, derives,
   widens, refreshes, or independently authorizes an `acs.dc.v1` capability.
   It requests an already-authorized capability from ACS per `tools/call` and
   transports it into `params._meta.acsCapability`. The ACS private signing
   key never reaches the gateway, bridge, Desktop Commander, Mission Router,
   or Codex Swarm processes.
2. **Forwarded identity is attribution, not authority.** The verified OAuth
   `sub`/`client_id` are forwarded to ACS as attribution metadata. They grant
   nothing by themselves; a spoofed or missing identity can never substitute
   for a valid capability, approval, lease, fencing epoch, or scope.
3. **Managed mode fails closed.** `ACS_MANAGED_MODE=1` requires a fully
   configured ACS integration or the process refuses to start. If ACS is
   unreachable, rejects, or returns a malformed envelope, the `tools/call` is
   not forwarded to Desktop Commander (HTTP 503 with the ACS failure code).
   There is no `--standalone` fallback on the managed path: in managed mode
   `bridge.js` strips `--standalone` from the Desktop Commander command line,
   so DC itself rejects ungoverned tool calls. The standalone bridge remains
   available only by running `bridge.js` without `ACS_MANAGED_MODE` (legacy
   deployment, not the managed gateway path).
4. **ACS approval is canonical.** Any `approvalId` inside a capability payload
   originates from ACS state; ACS consumes approvals transactionally at
   issuance. The gateway's OAuth consent passphrase remains pure UX for
   client registration and creates no second approval authority.
5. **Lease-safe lifecycle.** The multi-session bridge never recycles the
   canonical executor for normal downstream session creation. It invalidates
   sessions and replaces the upstream transport only after an actual upstream
   exit; `recycle-policy.js` remains a pure, tested policy helper for any
   future governed recovery path and never authorizes a mid-attempt kill.

## Required ACS endpoints (issuer side; contract)

The gateway is transport-only and uses the implemented ACS routes:

- `POST /dc/capability/issue` — body
  `{client_id, tool, argsSummary, correlationId}`, with the dedicated worker
  credential and `x-dc-actor` attribution header. ACS evaluates policy,
  approval, normalized invocation, runtime registration, and containment,
  claims the attempt with a lease and fence, commits issuance evidence, and
  returns `{decision:"allow", capability, workItemId, attemptId, leaseId, ...}`
  or a structured refusal. The edge forwards only the signed arguments.
- `POST /dc/runtime/bootstrap` — body
  `{runtimeId, identityConfigFingerprint, scopes}`; issues a short-lived
  challenge to the dedicated DC bridge.
- `POST /dc/runtime/bootstrap/complete` — the same binding plus `challenge`
  and the child's exact `runtimeIdentity` proof. Success is HTTP 204. Missing,
  mismatched, expired, consumed, revoked, or drifted bindings fail closed.

### Release identity binding

For an immutable DC release, configure `ACS_DC_RELEASE_DIR` on both bridge
and edge. `dcRuntimeIdentityFromState` verifies `RELEASE.json`, the full file
manifest, runtime inputs, installed dependencies, and pinned Node identity.
It sends that verified `runtimeIdentityDigest` as `identityConfigFingerprint`,
matching ACS's registered release identity. `ACS_DC_ENTRYPOINT`, when set,
must equal `<release>/dist/index.js`; the bridge derives it from its actual
child command. The child state supplies the runtime ID, not authority.

A configured invalid release returns no identity and cannot fall back to
entrypoint hashing. Unpackaged development without `ACS_DC_RELEASE_DIR`
retains the entrypoint hash contract. Do not use that development identity
for a registry bound to an immutable release digest. Deploy the verifier
and helper together in a new release; do not edit a published release or
change registry fingerprints to accommodate an inconsistent bridge.

The verifier lives in `@agent-control-stack/release-integrity`; standalone
gateway packaging must install that package inside the release. See the
[release integrity runbook](../../../docs/runbooks/release-integrity.md).

The ACS signing path MUST reuse the existing in-repo implementation
(`prepareDesktopCommanderCapability` / `signPreparedDesktopCommanderCapability`
+ `SqliteDesktopCommanderRuntimeRegistry`); the ACS private key stays inside
the ACS process boundary.

## Gateway behavior (implemented)

- `managed.js`: config guard, ACS transport client, identity attribution,
  per-call capability transport. Client-supplied `_meta.acs*` metadata is
  always stripped before the ACS round-trip (anti-spoof) and the forwarded
  request carries only the ACS-issued envelope.
- `server.js` `ACS_MANAGED_MODE=1`: on each single `tools/call`, request
  a capability from ACS → inject → forward. A refusal is returned as HTTP 200
  with a JSON-RPC error preserving the request `id`: `-32001` denied,
  `-32002` approval required, or `-32003` authorization unavailable.
  Nothing reaches DC on any refusal. Managed initialize failures and rejected
  batched tool calls remain HTTP 503 transport failures.
- `bridge.js` `ACS_MANAGED_MODE=1`: spawns DC without `--standalone` while
  preserving the multi-session router; `/healthz` remains the stable `ok`
  response for existing MCP health checks.

## Test evidence

`node --test test/managed.test.mjs` — 12/12 pass: spoofed `_meta` stripped and
replaced by the ACS envelope; fail-closed on ACS deny codes covering missing/
forged/expired capability, wrong scope, approval mismatch, attempt/lease/
fencing mismatch, stale/competing lease, nonce replay; fail-closed when ACS is
unreachable; managed mode refuses unconfigured startup; fresh capability per
call (no gateway replay/cache path); lease-safe recycle decisions.

## Client attribution (visibility only)

The edge verifies the OAuth token, so `client_id` and `sub` are trustworthy. It additionally caches each client's
`initialize.clientInfo`, forwards it with the `User-Agent` to ACS issuance as `x-mcp-client-name`,
`x-mcp-client-version` and `x-mcp-user-agent`, and reports `initialize` and `tools/list` to ACS
`POST /mcp-clients/observe` (fire-and-forget, 1.5 s timeout, throttled). These are unverified claims for
operators; they never affect authorization, and a failure to report never affects a request. See ADR 0023.

